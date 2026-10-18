#!/usr/bin/env bash
# Rack topology for the burrow test cluster: 127.0.0.2,.3 -> /rack1 ; 127.0.0.4 -> /rack2
# Hadoop passes one or more host/IP arguments and expects one rack per argument on a single line.
out=""
for h in "$@"; do
  case "$h" in
    127.0.0.2|127.0.0.3) out="$out /rack1" ;;
    127.0.0.4)           out="$out /rack2" ;;
    *)                   out="$out /default-rack" ;;
  esac
done
echo $out
