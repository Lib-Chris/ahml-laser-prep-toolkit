-- Double-click launcher for the AHML Makerplace Laser Prep Tool Kit.
-- Keep this file in the SAME folder as "AHML Makerplace Laser Prep Tool
-- Kit.jsx" - it finds the script next to itself, so the whole folder can
-- be copied anywhere (a shared makerspace station, a USB drive, another
-- library) and still work.

set myFolder to ""
tell application "Finder"
	set myFolder to (container of (path to me)) as alias
end tell
set jsxPath to ((myFolder as text) & "AHML Makerplace Laser Prep Tool Kit.jsx") as alias
set jsSrc to read jsxPath as «class utf8»

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
