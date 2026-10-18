#!/bin/bash

set -o pipefail -e
export PRELAUNCH_OUT="/home/puppyseal/Documents/code_repos/burrow/.cluster/state/data/nm3-logs/application_1791010984040_0034/container_1791010984040_0034_01_000001/prelaunch.out"
exec >"${PRELAUNCH_OUT}"
export PRELAUNCH_ERR="/home/puppyseal/Documents/code_repos/burrow/.cluster/state/data/nm3-logs/application_1791010984040_0034/container_1791010984040_0034_01_000001/prelaunch.err"
exec 2>"${PRELAUNCH_ERR}"
echo "Setting up env variables"
export HADOOP_COMMON_HOME=${HADOOP_COMMON_HOME:-"/home/puppyseal/Documents/code_repos/burrow/.cluster/hadoop-3.4.3"}
export HADOOP_HDFS_HOME=${HADOOP_HDFS_HOME:-"/home/puppyseal/Documents/code_repos/burrow/.cluster/hadoop-3.4.3"}
export HADOOP_CONF_DIR=${HADOOP_CONF_DIR:-"/home/puppyseal/Documents/code_repos/burrow/.cluster/state/conf-nm3"}
export HADOOP_YARN_HOME=${HADOOP_YARN_HOME:-"/home/puppyseal/Documents/code_repos/burrow/.cluster/hadoop-3.4.3"}
export HADOOP_HOME=${HADOOP_HOME:-"/home/puppyseal/Documents/code_repos/burrow/.cluster/hadoop-3.4.3"}
export HADOOP_MAPRED_HOME=${HADOOP_MAPRED_HOME:-"/home/puppyseal/Documents/code_repos/burrow/.cluster/hadoop-3.4.3"}
export PATH=${PATH:-"/home/puppyseal/Documents/code_repos/burrow/.cluster/jdk-17.0.20.1+1/bin:/home/puppyseal/Documents/code_repos/burrow/.cluster/hadoop-3.4.3/bin:/home/puppyseal/.opencode/bin:/home/puppyseal/.opencode/bin:/home/puppyseal/.bun/bin:/home/puppyseal/.cargo/bin:/home/puppyseal/.opencode/bin:/home/puppyseal/.local/bin:/home/puppyseal/bin:/usr/local/bin:/usr/bin:/bin"}
export LANG=${LANG:-"en_US.UTF-8"}
export HADOOP_TOKEN_FILE_LOCATION="/home/puppyseal/Documents/code_repos/burrow/.cluster/state/data/nm3-local/usercache/bob/appcache/application_1791010984040_0034/container_1791010984040_0034_01_000001/container_tokens"
export CONTAINER_ID="container_1791010984040_0034_01_000001"
export NM_PORT="8041"
export NM_HOST="127.0.0.4"
export NM_HTTP_PORT="8042"
export LOCAL_DIRS="/home/puppyseal/Documents/code_repos/burrow/.cluster/state/data/nm3-local/usercache/bob/appcache/application_1791010984040_0034"
export LOCAL_USER_DIRS="/home/puppyseal/Documents/code_repos/burrow/.cluster/state/data/nm3-local/usercache/bob/"
export LOG_DIRS="/home/puppyseal/Documents/code_repos/burrow/.cluster/state/data/nm3-logs/application_1791010984040_0034/container_1791010984040_0034_01_000001"
export USER="bob"
export LOGNAME="bob"
export HOME="/home/"
export PWD="/home/puppyseal/Documents/code_repos/burrow/.cluster/state/data/nm3-local/usercache/bob/appcache/application_1791010984040_0034/container_1791010984040_0034_01_000001"
export LOCALIZATION_COUNTERS="3989304,0,5,0,226"
export JVM_PID="$$"
export NM_AUX_SERVICE_mapreduce_shuffle="AAA0/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
export SPARK_YARN_STAGING_DIR="file:/home/puppyseal/Documents/code_repos/burrow/.cluster/state/data/staging/bob/.sparkStaging/application_1791010984040_0034"
export SPARK_PREFER_IPV6="false"
export JAVA_HOME="/home/puppyseal/Documents/code_repos/burrow/.cluster/jdk-17.0.20.1+1"
export APP_SUBMIT_TIME_ENV="1791013899668"
export PYSPARK_PYTHON="/home/puppyseal/Documents/code_repos/burrow/.venv/bin/python"
export PYTHONHASHSEED="0"
export PYTHONPATH="$PWD/__pyfiles__:$PWD/pyspark.zip:$PWD/py4j-0.10.9.9-src.zip"
export APPLICATION_WEB_PROXY_BASE="/proxy/application_1791010984040_0034"
export CLASSPATH="$PWD:$PWD/__spark_conf__:$PWD/__spark_libs__/*:/home/puppyseal/Documents/code_repos/burrow/.venv/lib/python3.12/site-packages/pyspark/jars/*:$PWD/__spark_conf__/__hadoop_conf__"
export SPARK_USER="bob"
export MALLOC_ARENA_MAX="4"
echo "Setting up job resources"
ln -sf -- "/home/puppyseal/Documents/code_repos/burrow/.cluster/state/data/nm3-local/usercache/bob/filecache/35/pyspark.zip" "pyspark.zip"
ln -sf -- "/home/puppyseal/Documents/code_repos/burrow/.cluster/state/data/nm3-local/usercache/bob/filecache/37/py4j-0.10.9.9-src.zip" "py4j-0.10.9.9-src.zip"
ln -sf -- "/home/puppyseal/Documents/code_repos/burrow/.cluster/state/data/nm3-local/usercache/bob/filecache/39/long_running.py" "long_running.py"
mkdir -p __pyfiles__
ln -sf -- "/home/puppyseal/Documents/code_repos/burrow/.cluster/state/data/nm3-local/usercache/bob/filecache/36/_common.py" "__pyfiles__/_common.py"
ln -sf -- "/home/puppyseal/Documents/code_repos/burrow/.cluster/state/data/nm3-local/usercache/bob/filecache/38/__spark_conf__.zip" "__spark_conf__"
echo "Copying debugging information"
# Creating copy of launch script
cp "launch_container.sh" "/home/puppyseal/Documents/code_repos/burrow/.cluster/state/data/nm3-logs/application_1791010984040_0034/container_1791010984040_0034_01_000001/launch_container.sh"
chmod 640 "/home/puppyseal/Documents/code_repos/burrow/.cluster/state/data/nm3-logs/application_1791010984040_0034/container_1791010984040_0034_01_000001/launch_container.sh"
# Determining directory contents
echo "ls -l:" 1>"/home/puppyseal/Documents/code_repos/burrow/.cluster/state/data/nm3-logs/application_1791010984040_0034/container_1791010984040_0034_01_000001/directory.info"
ls -l 1>>"/home/puppyseal/Documents/code_repos/burrow/.cluster/state/data/nm3-logs/application_1791010984040_0034/container_1791010984040_0034_01_000001/directory.info"
echo "find -L . -maxdepth 5 -ls:" 1>>"/home/puppyseal/Documents/code_repos/burrow/.cluster/state/data/nm3-logs/application_1791010984040_0034/container_1791010984040_0034_01_000001/directory.info"
find -L . -maxdepth 5 -ls 1>>"/home/puppyseal/Documents/code_repos/burrow/.cluster/state/data/nm3-logs/application_1791010984040_0034/container_1791010984040_0034_01_000001/directory.info"
echo "broken symlinks(find -L . -maxdepth 5 -type l -ls):" 1>>"/home/puppyseal/Documents/code_repos/burrow/.cluster/state/data/nm3-logs/application_1791010984040_0034/container_1791010984040_0034_01_000001/directory.info"
find -L . -maxdepth 5 -type l -ls 1>>"/home/puppyseal/Documents/code_repos/burrow/.cluster/state/data/nm3-logs/application_1791010984040_0034/container_1791010984040_0034_01_000001/directory.info"
echo "Launching container"
exec /bin/bash -c "$JAVA_HOME/bin/java -server -Djava.net.preferIPv6Addresses=false -XX:+IgnoreUnrecognizedVMOptions --add-modules=jdk.incubator.vector --add-opens=java.base/java.lang=ALL-UNNAMED --add-opens=java.base/java.lang.invoke=ALL-UNNAMED --add-opens=java.base/java.lang.reflect=ALL-UNNAMED --add-opens=java.base/java.io=ALL-UNNAMED --add-opens=java.base/java.net=ALL-UNNAMED --add-opens=java.base/java.nio=ALL-UNNAMED --add-opens=java.base/java.util=ALL-UNNAMED --add-opens=java.base/java.util.concurrent=ALL-UNNAMED --add-opens=java.base/java.util.concurrent.atomic=ALL-UNNAMED --add-opens=java.base/jdk.internal.ref=ALL-UNNAMED --add-opens=java.base/sun.nio.ch=ALL-UNNAMED --add-opens=java.base/sun.nio.cs=ALL-UNNAMED --add-opens=java.base/sun.security.action=ALL-UNNAMED --add-opens=java.base/sun.util.calendar=ALL-UNNAMED --add-opens=java.security.jgss/sun.security.krb5=ALL-UNNAMED -Dio.netty.tryReflectionSetAccessible=true -Dio.netty.allocator.type=pooled -Dio.netty.handler.ssl.defaultEndpointVerificationAlgorithm=NONE --sun-misc-unsafe-memory-access=allow --enable-native-access=ALL-UNNAMED -Xmx512m -Djava.io.tmpdir=$PWD/tmp '-XX:+UseSerialGC' -Dspark.yarn.app.container.log.dir=/home/puppyseal/Documents/code_repos/burrow/.cluster/state/data/nm3-logs/application_1791010984040_0034/container_1791010984040_0034_01_000001 org.apache.spark.deploy.yarn.ApplicationMaster --class 'org.apache.spark.deploy.PythonRunner' --primary-py-file long_running.py --arg '--duration' --arg '2400' --arg '--task-ms' --arg '250' --arg '--rows' --arg '30000' --properties-file $PWD/__spark_conf__/__spark_conf__.properties --dist-cache-conf $PWD/__spark_conf__/__spark_dist_cache__.properties 1> /home/puppyseal/Documents/code_repos/burrow/.cluster/state/data/nm3-logs/application_1791010984040_0034/container_1791010984040_0034_01_000001/stdout 2> /home/puppyseal/Documents/code_repos/burrow/.cluster/state/data/nm3-logs/application_1791010984040_0034/container_1791010984040_0034_01_000001/stderr"
