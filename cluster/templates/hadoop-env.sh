#!/usr/bin/env bash
# burrow test cluster — rendered by cluster.py setup.
export JAVA_HOME=@@JAVA_HOME@@
export HADOOP_OS_TYPE=Linux
export LANG=en_US.UTF-8
export HADOOP_PREFIX=@@HADOOP_HOME@@
# JDK 17 runs Hadoop 3.4.3 daemons with these module opens (found empirically, see cluster/README.md).
OPENS=""
for p in java.lang java.lang.reflect java.lang.invoke java.io java.net java.nio java.nio.charset java.util java.util.concurrent \
         java.util.concurrent.atomic java.util.regex java.text java.math java.security java.time sun.nio.ch sun.nio.cs sun.security.action \
         sun.util.calendar sun.net.dns; do
  OPENS="$OPENS --add-opens=java.base/$p=ALL-UNNAMED"
done
OPENS="$OPENS --add-exports=java.base/sun.net.dns=ALL-UNNAMED --add-exports=java.base/sun.net.util=ALL-UNNAMED"
OPENS="$OPENS --add-opens=java.security.jgss/sun.security.krb5=ALL-UNNAMED"
export HADOOP_OPTS="-Djava.net.preferIPv4Stack=true -Djava.awt.headless=true -Dsun.net.inetaddr.ttl=60 $OPENS"
# Small footprint daemons: serial GC, small caches. Later -Xmx wins over anything earlier.
SMALL="-XX:+UseSerialGC -Xss512k -XX:MaxMetaspaceSize=192m -XX:ReservedCodeCacheSize=64m -XX:-UsePerfData"
export YARN_RESOURCEMANAGER_OPTS="$SMALL -Xms128m -Xmx@@RM_HEAP@@m"
export YARN_NODEMANAGER_OPTS="$SMALL -Xms64m -Xmx@@NM_HEAP@@m"
export MAPRED_HISTORYSERVER_OPTS="$SMALL -Xms64m -Xmx@@JHS_HEAP@@m"
export HADOOP_CLIENT_OPTS="-XX:+UseSerialGC -Xmx256m"
export HADOOP_ROOT_LOGGER=INFO,RFA
export HADOOP_DAEMON_ROOT_LOGGER=INFO,RFA
