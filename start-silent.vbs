' Start Agent Lab in the background: no console window, logs to launch.log.
' ASCII-only on purpose: the system script host reads this file with the
' legacy codepage, and non-ASCII bytes here can eat a newline and turn the next
' real line into a comment.
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")

' Set the working directory through the COM object, NOT on the command line.
' This matters: this project sits under a path with non-ASCII characters, and
' "cmd /c cd /d <that path>" gets those bytes mangled by the GBK codepage.
' cmd then answers "The filename, directory name, or volume label syntax is
' incorrect" and never runs node at all. The "> launch.log" redirect still
' creates an empty file, so it looks like the app started quietly when in fact
' nothing ran.
'
' shell.CurrentDirectory goes through COM (Unicode), so the path survives and
' the command line below only needs the relative file name.
shell.CurrentDirectory = here
cmd = "cmd /c node start.mjs > launch.log 2>&1"

' 0 = hidden window, False = do not wait for it to finish.
shell.Run cmd, 0, False
