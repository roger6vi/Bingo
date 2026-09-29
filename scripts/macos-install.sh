#!/usr/bin/env bash
# Install Bingo.app from a dmg or zip, replacing any installed copy, and print its executable (#40).
# Usage: scripts/macos-install.sh <Bingo-*.dmg | Bingo-*-mac.zip> <applications dir> <expected version>
set -euo pipefail
package=$1 target=$2 version=$3
[ -f "$package" ] || { echo "package not found: $package" >&2; exit 1; }
mkdir -p "$target"
# Replace the bundle as a whole, as dragging a newer app over an older one does.
rm -rf "$target/Bingo.app"
case $package in
  *.dmg)
    mount=$(mktemp -d)
    hdiutil attach -nobrowse -readonly -mountpoint "$mount" "$package" >&2
    trap 'hdiutil detach "$mount" -quiet' EXIT
    ditto "$mount/Bingo.app" "$target/Bingo.app" ;;
  *.zip) ditto -x -k "$package" "$target" ;;
  *) echo "unsupported package: $package" >&2; exit 1 ;;
esac
installed=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$target/Bingo.app/Contents/Info.plist")
[ "$installed" = "$version" ] || { echo "installed $installed, expected $version" >&2; exit 1; }
codesign --verify --deep --strict "$target/Bingo.app" >&2
echo "Bingo $installed installed at $target/Bingo.app" >&2
echo "$target/Bingo.app/Contents/MacOS/Bingo"
