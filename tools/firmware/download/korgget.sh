#!/bin/sh
# korgget.sh <list>  lines: Model|version|filename|folder   (URL looked up in $TEMP/korg*.txt by file name)
while IFS='|' read -r model ver file folder; do
  [ -z "$model" ] && continue
  url=$(grep -h "^  URL .*%27%27${file}&" "$TEMP"/korg*.txt | head -1 | sed 's/^  URL //')
  if [ -z "$url" ]; then echo "NOURL $file"; continue; fi
  if [ -n "$folder" ]; then node fw.mjs get Korg "$model" "$ver" "$url" --name "$file" --folder "$folder"; else node fw.mjs get Korg "$model" "$ver" "$url" --name "$file"; fi
done < "$1"
