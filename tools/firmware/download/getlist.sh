#!/bin/sh
# getlist.sh <Maker> <list file> <url prefix>   lines: Model|version|file|folder
maker="$1"; list="$2"; prefix="$3"
while IFS='|' read -r model ver file folder; do
  [ -z "$model" ] && continue
  case "$model" in \#*) continue;; esac
  if [ -n "$folder" ]; then node fw.mjs get "$maker" "$model" "$ver" "$prefix$file" --folder "$folder"; else node fw.mjs get "$maker" "$model" "$ver" "$prefix$file"; fi
done < "$list"
