import AppKit
import Foundation
import WebKit

// Agent Lab 的 macOS 原生壳。
//
// 它只做三件事，其余全部交给桥（app/server.mjs）：
//   1. 在自己的 Resources 里找到内置 Node，拉起本地桥；
//   2. 等桥真的能应答了，再用 WKWebView 打开 127.0.0.1 那个地址；
//   3. App 退出时把桥和 Node 一起收掉，不留后台进程。
//
// 为什么不是浏览器 --app= 模式：那个方案依赖用户装了 Chrome/Edge，
// 而且窗口里还能右键出「查看源代码」。这里是自己的窗口，Dock 里有自己的图标。

// 自检模式：命令行下跑 `AgentLab --self-test` 只验证"内置 Node + 桥"这一层。
// GUI 回调依赖窗口服务器，在没有 GUI session 的环境里（CI、SSH）根本不会触发，
// 那样就只能看到一个活着但什么都不做的进程。自检把最容易坏的那一段单独拎出来验证。
func runSelfTest() -> Int32 {
    guard let node = RuntimeLocator.findNode() else {
        print("SELFTEST FAIL: 没找到内置 Node")
        return 1
    }
    print("SELFTEST node: \(node)")
    let root = RuntimeLocator.appRoot()
    let script = root.appendingPathComponent("server.mjs").path
    guard FileManager.default.fileExists(atPath: script) else {
        print("SELFTEST FAIL: 桥脚本不存在: \(script)")
        return 1
    }
    print("SELFTEST bridge: \(script)")
    let p = Process()
    p.executableURL = URL(fileURLWithPath: node)
    p.arguments = [script]
    var env = ProcessInfo.processInfo.environment
    let port = 8799
    env["PORT"] = String(port)
    env["AGENT_CWD"] = NSTemporaryDirectory()
    p.environment = env
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    do { try p.run() } catch {
        print("SELFTEST FAIL: 桥起不来: \(error)")
        return 1
    }
    // 最多等 20 秒，轮询 /api/info
    let url = URL(string: "http://127.0.0.1:\(port)/api/info")!
    let deadline = Date().addingTimeInterval(20)
    while Date() < deadline {
        Thread.sleep(forTimeInterval: 0.5)
        var ok = false
        let sem = DispatchSemaphore(value: 0)
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { _, res, _ in
            ok = (res as? HTTPURLResponse)?.statusCode == 200
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 2)
        if ok {
            print("SELFTEST OK: 内置 Node 拉起桥并在 \(port) 应答")
            p.terminate()
            return 0
        }
    }
    p.terminate()
    print("SELFTEST FAIL: 20 秒内桥没应答")
    print(String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "")
    return 1
}

enum RuntimeLocator {
    static func resources() -> URL {
        Bundle.main.resourceURL ?? Bundle.main.bundleURL
    }
    static func findNode() -> String? {
        let root = resources().appendingPathComponent("runtime", isDirectory: true)
        let candidates = [
            root.appendingPathComponent("node-arm64/bin/node").path,
            root.appendingPathComponent("node-x64/bin/node").path,
        ]
        if let hit = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
            return hit
        }
        for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
            if FileManager.default.isExecutableFile(atPath: p) { return p }
        }
        return nil
    }
    static func appRoot() -> URL {
        let packaged = resources().appendingPathComponent("app", isDirectory: true)
        if FileManager.default.fileExists(atPath: packaged.appendingPathComponent("server.mjs").path) {
            return packaged
        }
        return URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("app", isDirectory: true)
    }
}

@main
struct AgentLabMain {
    // --self-test 走命令行自检，其余交给 NSApplication 的正常生命周期。
    static func main() {
        if CommandLine.arguments.contains("--self-test") {
            exit(runSelfTest())
        }
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        // 持有 delegate：NSApplication.delegate 是 weak，不持有会被立刻释放，
        // 表现就是窗口一闪就没、或者干脆什么都不发生。
        _ = Unmanaged.passRetained(delegate)
        app.run()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var server: Process?
    private var pollTimer: Timer?
    private var pollInFlight = false
    private var pollDone = false
    private var shutdown = false

    private let port: Int = 8787
    private var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildWindow()
        startServer()
        waitForServerThenLoad()
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopServer()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // ---------- 窗口 ----------
    private func buildWindow() {
        let rect = NSRect(x: 0, y: 0, width: 1280, height: 860)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Agent Lab"
        window.center()
        window.minSize = NSSize(width: 720, height: 520)
        window.titlebarAppearsTransparent = false

        let config = WKWebViewConfiguration()
        // 页面只用 http://127.0.0.1 自己的接口，不需要读本地文件。
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: rect, configuration: config)
        webView.navigationDelegate = self
        // 加载中先给个底色，避免白闪。
        webView.setValue(NSColor.windowBackgroundColor, forKey: "backgroundColor")
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // ---------- 内置 Node 与桥 ----------
    private func resources() -> URL { RuntimeLocator.resources() }
    private func findNode() -> String? { RuntimeLocator.findNode() }
    private func appRoot() -> URL { RuntimeLocator.appRoot() }

    private func startServer() {
        guard let node = findNode() else {
            showFailure("没找到 Node 运行时", detail: "这个 App 应该在 Contents/Resources/runtime 里自带 Node；如果没带，请先安装 Node 后重试。")
            return
        }
        let root = appRoot()
        let script = root.appendingPathComponent("server.mjs").path
        guard FileManager.default.fileExists(atPath: script) else {
            showFailure("桥接脚本缺失", detail: script)
            return
        }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [script]
        // 桥靠环境变量定位资源和内核；不给它这些，它会去猜 PATH。
        var env = ProcessInfo.processInfo.environment
        env["PORT"] = String(port)
        // 会话默认工作目录：用户主目录下的 AgentLab，不存在就建一个。
        let ws = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("AgentLab", isDirectory: true)
        if !FileManager.default.fileExists(atPath: ws.path) {
            try? FileManager.default.createDirectory(at: ws, withIntermediateDirectories: true)
        }
        env["AGENT_CWD"] = ws.path
        // 自带 Node 不在 PATH 里，MCP 服务进程也要用它，显式指过去。
        env["PATH"] = "\(URL(fileURLWithPath: node).deletingLastPathComponent().path):\(env["PATH"] ?? "/usr/bin:/bin")"
        // 告诉桥"我是谁"，让它在壳退出后自己收掉（防孤儿进程占端口）。
        env["AGENT_LAB_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        p.environment = env
        p.currentDirectoryURL = root.deletingLastPathComponent()

        // 桥的 stdout/stderr 进了日志，出问题能查。
        let logDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/AgentLab", isDirectory: true)
        try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        let logPath = logDir.appendingPathComponent("bridge.log").path
        FileManager.default.createFile(atPath: logPath, contents: nil)
        if let handle = FileHandle(forWritingAtPath: logPath) {
            handle.seekToEndOfFile()
            p.standardOutput = handle
            p.standardError = handle
        }

        // 关掉最后一个窗口时把桥一起收掉，不然会留一个孤儿 node 占着端口。
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self = self, !self.shutdown else { return }
                NSLog("[AgentLab] 桥已退出，code=\(proc.terminationStatus)")
            }
        }

        do {
            try p.run()
            server = p
        } catch {
            showFailure("桥启动失败", detail: error.localizedDescription)
        }
    }

    private func stopServer() {
        shutdown = true
        pollTimer?.invalidate()
        pollTimer = nil
        guard let p = server, p.isRunning else { return }
        p.terminate()
        // 给它一点时间自己收尾（关内核子进程），超时就硬杀。
        DispatchQueue.global().asyncAfter(deadline: .now() + 2.0) {
            if p.isRunning { p.interrupt() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                if p.isRunning { kill(p.processIdentifier, SIGKILL) }
            }
        }
    }

    // ---------- 等桥就绪再加载 ----------
    // 桥要加载模块、拉起 codex 内核，可能要好几秒。直接 load 会先显示
    // 「无法连接」，再靠用户手刷。这里轮询 /api/info，通了才真正加载。
    private func waitForServerThenLoad() {
        let deadline = Date().addingTimeInterval(60)
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] timer in
            guard let self = self else { timer.invalidate(); return }
            guard !self.shutdown, !self.pollDone, !self.pollInFlight else { return }
            self.pollInFlight = true
            self.probe { [weak self] ok in
                guard let self = self else { return }
                guard !self.shutdown, !self.pollDone else { return }
                self.pollInFlight = false
                if ok {
                    self.pollDone = true
                    timer.invalidate()
                    self.pollTimer = nil
                    self.webView.load(URLRequest(url: self.baseURL))
                } else if Date() >= deadline {
                    self.pollDone = true
                    timer.invalidate()
                    self.pollTimer = nil
                    self.showFailure(
                        "本地服务没能启动",
                        detail: "已等待 60 秒详细日志见 ~/Library/Logs/AgentLab/bridge.log"
                    )
                }
            }
        }
    }

    private func probe(_ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/info"))
        req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { _, res, _ in
            let ok = (res as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                done(ok)
            }
        }.resume()
    }

    private func showFailure(_ title: String, detail: String) {
        let html = """
        <html><body style="font:14px -apple-system,sans-serif;padding:40px;color:#333">
        <h2>\(title)</h2><p>\(detail)</p>
        </body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }
}

extension AppDelegate: WKNavigationDelegate {
    // 页面里的外链交给系统浏览器，别在 App 窗口里打开一个新世界。
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.allow); return }
        if url.host == "127.0.0.1" || url.host == "localhost" || url.scheme == "about" || url.scheme == "file" {
            decisionHandler(.allow)
        } else {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        }
    }
}
