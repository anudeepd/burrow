#!/usr/bin/env bash
# Reproducible extraction of every Hadoop 3.4.3 source/binary artefact the inventory is derived from.
# Output: .cluster/src-extract/<module>/…  (git-ignored)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
H="$ROOT/.cluster/hadoop"
OUT="$ROOT/.cluster/src-extract"
mkdir -p "$OUT"
# 1. every YARN sources jar (non-test)
for j in "$H"/share/hadoop/yarn/sources/*-3.4.3-sources.jar; do
  m="$(basename "$j" -3.4.3-sources.jar)"; mkdir -p "$OUT/$m"; unzip -qo "$j" -d "$OUT/$m"
done
# 2. MapReduce JobHistory server + common (JHS REST/aggregated-log endpoints)
for m in hs common; do
  mkdir -p "$OUT/hadoop-mapreduce-client-$m"
  unzip -qo "$H/share/hadoop/mapreduce/sources/hadoop-mapreduce-client-$m-3.4.3-sources.jar" -d "$OUT/hadoop-mapreduce-client-$m"
done
# 3. hadoop-common daemon-page servlets (/conf /jmx /stacks /logs /logLevel, HttpServer2)
mkdir -p "$OUT/hadoop-common"
unzip -qo "$H/share/hadoop/common/sources/hadoop-common-3.4.3-sources.jar" \
  'org/apache/hadoop/http/*' 'org/apache/hadoop/jmx/*' 'org/apache/hadoop/conf/*' 'org/apache/hadoop/log/*' \
  'org/apache/hadoop/util/StringUtils.java' 'org/apache/hadoop/util/Time.java' -d "$OUT/hadoop-common"
# 4. yarn-default.xml (config-gated behaviour) from the compiled common jar
mkdir -p "$OUT/common-bin"
unzip -qo "$H/share/hadoop/yarn/hadoop-yarn-common-3.4.3.jar" yarn-default.xml -d "$OUT/common-bin"
# 5. UI2 (compiled Ember app) is read in place: $H/share/hadoop/yarn/webapps/ui2
echo "extracted into $OUT"
