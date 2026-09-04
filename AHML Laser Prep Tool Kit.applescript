-- Double-click launcher for the AHML Makerplace Laser Prep Tool Kit.
-- Keep this file in the SAME folder as "AHML Makerplace Laser Prep Tool
-- Kit.jsx" - it finds the script next to itself, so the whole folder can
-- be copied anywhere (a shared makerspace station, a USB drive, another
-- library) and still work.

on jsEscape(str)
	set AppleScript's text item delimiters to "\\"
	set theParts to text items of str
	set AppleScript's text item delimiters to "\\\\"
	set str to theParts as text
	set AppleScript's text item delimiters to "\""
	set theParts to text items of str
	set AppleScript's text item delimiters to "\\\""
	set str to theParts as text
	set AppleScript's text item delimiters to ""
	return str
end jsEscape

set myFolder to ""
tell application "Finder"
	set myFolder to (container of (path to me)) as alias
end tell
set jsxPath to ((myFolder as text) & "AHML Makerplace Laser Prep Tool Kit.jsx") as alias

set posixFolder to POSIX path of myFolder
if posixFolder ends with "/" then set posixFolder to text 1 thru -2 of posixFolder

-- Tell the script its own folder explicitly - reading the file into a
-- string like this means Illustrator's own $.fileName can't tell where
-- the script actually lives, which the card-icon menu needs to find its
-- image assets.
set jsPrelude to "var __LAUNCHER_FOLDER = \"" & my jsEscape(posixFolder) & "\";" & return
set jsSrc to jsPrelude & (read jsxPath as «class utf8»)

set alreadyRunning to application "Adobe Illustrator" is running

tell application "Adobe Illustrator"
	activate
end tell

-- Give Illustrator a moment to finish launching if it was just opened.
if not alreadyRunning then delay 3

tell application "Adobe Illustrator"
	try
		do javascript jsSrc
	on error errMsg
		display alert "Laser Prep Tool Kit" message "Illustrator wasn't ready yet. Please double-click the icon again." as warning
	end try
end tell
