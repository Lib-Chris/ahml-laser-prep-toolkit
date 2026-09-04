' AHML Laser Prep Tool Kit - Windows launcher
' Keep this file in the SAME folder as "AHML Makerplace Laser Prep Tool
' Kit.jsx" - it finds the script next to itself, so the whole folder can
' be copied anywhere (a shared makerspace station, a USB drive, another
' library) and still work.
'
' NOTE: this launcher has not been tested against a real Windows copy of
' Illustrator (it was written and verified on macOS, where the equivalent
' AppleScript launcher IS tested). The Illustrator.Application COM object
' and DoJavaScript method are Adobe's documented Windows scripting API,
' but if this doesn't work on your machine, the .jsx file itself still
' works fine the normal way: File > Scripts > Other Script...

Dim fso, scriptFolder, jsxPath, jsSrc, illustrator, f

Set fso = CreateObject("Scripting.FileSystemObject")
scriptFolder = fso.GetParentFolderName(WScript.ScriptFullName)
jsxPath = fso.BuildPath(scriptFolder, "AHML Makerplace Laser Prep Tool Kit.jsx")

If Not fso.FileExists(jsxPath) Then
    MsgBox "Could not find:" & vbCrLf & jsxPath & vbCrLf & vbCrLf & _
        "Keep this launcher in the same folder as the .jsx file.", _
        vbExclamation, "AHML Laser Prep Tool Kit"
    WScript.Quit 1
End If

Set f = fso.OpenTextFile(jsxPath, 1, False, 0) ' 1=ForReading, 0=ASCII (file is plain ASCII)
jsSrc = f.ReadAll
f.Close

Dim wasRunning
wasRunning = True
On Error Resume Next
Set illustrator = GetObject(, "Illustrator.Application")
If Err.Number <> 0 Then
    Err.Clear
    wasRunning = False
    Set illustrator = CreateObject("Illustrator.Application")
    If Err.Number <> 0 Then
        MsgBox "Couldn't start Adobe Illustrator. Make sure it's installed on this machine." & _
            vbCrLf & vbCrLf & Err.Description, vbCritical, "AHML Laser Prep Tool Kit"
        WScript.Quit 1
    End If
End If
On Error Goto 0

' Give a freshly-launched Illustrator a moment to finish starting before
' talking to it.
If Not wasRunning Then WScript.Sleep 4000

On Error Resume Next
illustrator.DoJavaScript jsSrc
If Err.Number <> 0 Then
    MsgBox "Illustrator wasn't ready yet. Please double-click the icon again." & _
        vbCrLf & vbCrLf & Err.Description, vbExclamation, "AHML Laser Prep Tool Kit"
End If
On Error Goto 0
