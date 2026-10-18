#!/usr/bin/env python3
"""Generates parity/inventory/src/rest-nm.yaml (NodeManager REST).  Run: .venv/bin/python parity/inventory/tools/gen_rest_nm.py"""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from invlib import *

D = "nm:dao/"
objects = {}
JSON_NOTE = ("NM JSON = Jersey 1 JSONJAXBContext natural notation, rootUnwrapping(false) (nm:JAXBContextResolver.java:59): "
             "the @XmlRootElement name wraps the body; JAXB FIELD access => JSON key = Java field name; "
             "list fields are always arrays. [INFERENCE] an empty list is serialised as null/{} (RM shows {\"apps\":null}) - verify on live NM.")

# ---------------------------------------------------------------- NodeInfo
OBJ(objects, "NmNodeInfo", D + "NodeInfo.java", 33, [
    F("healthReport", "string", 39, D + "NodeInfo.java", note="empty string when healthy and no report (context.getNodeHealthStatus().getHealthReport(), NodeInfo.java:79)"),
    F("totalVmemAllocatedContainersMB", "long", 40, D + "NodeInfo.java", unit="MB", note="resourceView.getVmemAllocatedForContainers() / BYTES_IN_MB (NodeInfo.java:65)"),
    F("totalPmemAllocatedContainersMB", "long", 41, D + "NodeInfo.java", unit="MB", note="getPmemAllocatedForContainers() / BYTES_IN_MB (NodeInfo.java:68)"),
    F("totalVCoresAllocatedContainers", "long", 42, D + "NodeInfo.java", unit="count"),
    F("vmemCheckEnabled", "boolean", 43, D + "NodeInfo.java"),
    F("pmemCheckEnabled", "boolean", 44, D + "NodeInfo.java"),
    F("lastNodeUpdateTime", "long", 45, D + "NodeInfo.java", unit="epoch-ms", note="last health-report time"),
    F("resourceTypes", "string", 46, D + "NodeInfo.java", note="StringUtils.join(\", \", ResourceUtils.getResourcesTypeInfo()) (NodeInfo.java:73). Not in the 3.4.3 NodeManagerRest doc table."),
    F("nodeHealthy", "boolean", 47, D + "NodeInfo.java"),
    F("nodeManagerVersion", "string", 48, D + "NodeInfo.java"),
    F("nodeManagerBuildVersion", "string", 49, D + "NodeInfo.java"),
    F("nodeManagerVersionBuiltOn", "string", 50, D + "NodeInfo.java", note="YarnVersionInfo.getDate(), e.g. 2017-01-30T17:42Z (docs wrongly say ms since epoch)"),
    F("hadoopVersion", "string", 51, D + "NodeInfo.java"),
    F("hadoopBuildVersion", "string", 52, D + "NodeInfo.java"),
    F("hadoopVersionBuiltOn", "string", 53, D + "NodeInfo.java"),
    F("id", "string", 54, D + "NodeInfo.java", note="context.getNodeId().toString() = host:port (doc says long; source says String)"),
    F("nodeHostName", "string", 55, D + "NodeInfo.java"),
    F("nmStartupTime", "long", 56, D + "NodeInfo.java", unit="epoch-ms", note="NodeManager.getNMStartupTime()"),
], xml_root="nodeInfo",
    note="@XmlRootElement without name => default JAXB name 'nodeInfo'. @XmlAccessorType(FIELD): the odd getters (getNMVersion, getHealthStatus, getTotalVmemAllocated...) are NOT serialised.")

# ---------------------------------------------------------------- apps
OBJ(objects, "NmAppInfo", D + "AppInfo.java", 31, [
    F("id", "string", 35, D + "AppInfo.java", note="app.getAppId().toString()"),
    F("state", "string", 36, D + "AppInfo.java", note="app.getApplicationState().toString() = ApplicationState (NEW, INITING, RUNNING, FINISHING_CONTAINERS_WAIT, APPLICATION_RESOURCES_CLEANINGUP, FINISHED)"),
    F("user", "string", 37, D + "AppInfo.java"),
    F("containerids", "string", 38, D + "AppInfo.java", array=True, note="container id strings, order = HashMap key order of app.getContainers(); NOT named 'containers' in JSON (getter getContainers is ignored under FIELD access)"),
], xml_root="app")
OBJ(objects, "NmAppsInfo", D + "AppsInfo.java", 26, [
    F("app", "object", 30, D + "AppsInfo.java", array=True, ref="NmAppInfo"),
], xml_root="apps")

# ---------------------------------------------------------------- containers
OBJ(objects, "NmContainerInfo", D + "ContainerInfo.java", 38, [
    F("id", "string", 42, D + "ContainerInfo.java", note="container.getContainerId().toString()"),
    F("state", "string", 43, D + "ContainerInfo.java",
      note="container.getContainerState().toString() = NM ContainerState: NEW, LOCALIZING, LOCALIZATION_FAILED, SCHEDULED, RUNNING, RELAUNCHING, REINITIALIZING, REINITIALIZING_AWAITING_KILL, EXITED_WITH_SUCCESS, EXITED_WITH_FAILURE, KILLING, CONTAINER_CLEANEDUP_AFTER_KILL, CONTAINER_RESOURCES_CLEANINGUP, DONE, PAUSING, PAUSED, RESUMING (nmr:containermanager/container/ContainerState.java; the 3.4.3 doc lists a subset)"),
    F("exitCode", "int", 44, D + "ContainerInfo.java",
      note="containerData.getExitStatus(); -1000 (ContainerExitStatus.INVALID) until the container has exited. Legacy UI shows 'N/A' for -1000 (exitStatus, ContainerInfo.java:73)"),
    F("diagnostics", "string", 45, D + "ContainerInfo.java", note="\"\" when null/empty (ContainerInfo.java:77-80); non-empty only for failed/killed containers"),
    F("user", "string", 46, D + "ContainerInfo.java"),
    F("totalMemoryNeededMB", "long", 47, D + "ContainerInfo.java", unit="MB", note="res.getMemorySize(); 0 if container.getResource()==null (ContainerInfo.java:83-87)"),
    F("totalVCoresNeeded", "long", 48, D + "ContainerInfo.java", unit="count", note="res.getVirtualCores(); 0 if resource null"),
    F("executionType", "enum", 49, D + "ContainerInfo.java", values=["GUARANTEED", "OPPORTUNISTIC"],
      note="private field; container.getContainerTokenIdentifier().getExecutionType().name(). Missing from the pre-3.1 docs."),
    F("containerLogsLink", "string", 50, D + "ContainerInfo.java",
      note="join(requestUri, pathPrefix, 'containerlogs/<id>/<user>') where requestUri=uriInfo.getBaseUri() and pathPrefix=webapp.name()='node' => http://nm:8042/node/containerlogs/<cid>/<user> (ContainerInfo.java:90-100). Built by REST list/get only; the UI-side ctor passes ''"),
    F("nodeId", "string", 51, D + "ContainerInfo.java", note="nmContext.getNodeId().toString() = host:port"),
    F("containerLogFiles", "string", 57, D + "ContainerInfo.java", array=True,
      note="names of regular files in every local log dir of the container (ContainerLogsUtils.getContainerLogDirs, ContainerInfo.java:157-177); [] if the user is not authorised or the dirs do not exist. Order = File.listFiles() order (unsorted)."),
    # @XmlTransient: containerLogsShortLink (52-53), exitStatus (54-55)
], xml_root="container",
    note="@XmlTransient (not in JSON): containerLogsShortLink, exitStatus. Fields exist only for containers still in the NM context (nmContext.getContainers()); completed containers disappear after yarn.nodemanager.duration-to-track-stopped-containers.")
OBJ(objects, "NmContainersInfo", D + "ContainersInfo.java", 26, [
    F("container", "object", 30, D + "ContainersInfo.java", array=True, ref="NmContainerInfo"),
], xml_root="containers")

# ---------------------------------------------------------------- aux services
OBJ(objects, "NmAuxiliaryServiceInfo", D + "AuxiliaryServiceInfo.java", 30, [
    F("name", "string", 33, D + "AuxiliaryServiceInfo.java"),
    F("version", "string", 34, D + "AuxiliaryServiceInfo.java"),
    F("startTime", "string", 35, D + "AuxiliaryServiceInfo.java", note="SimpleDateFormat(\"yyyy-MM-dd HH:mm:ss\") of the launch time in the NM's default time zone (AuxiliaryServiceInfo.java:42-46) - a STRING, not epoch"),
], xml_root="service")
OBJ(objects, "NmAuxiliaryServicesInfo", D + "AuxiliaryServicesInfo.java", 31, [
    F("service", "object", 34, D + "AuxiliaryServicesInfo.java", array=True, ref="NmAuxiliaryServiceInfo"),
], xml_root="services")

# ---------------------------------------------------------------- container logs meta (shared shape lives in rest-daemon.yaml)
OBJ(objects, "NmContainerLogsInfo", D + "NMContainerLogsInfo.java", 41, [],
    xml_root="containerLogsInfo", extends="LogContainerLogsInfo",
    note="No own fields; see LogContainerLogsInfo (rest-daemon.yaml). Populated: logType=LOCAL, containerId, nodeId=nmContext.getNodeId(), containerLogsInfo[]={fileName, fileSize=Long.toString(length), lastModifiedTime=Times.format(lastModified)} of every regular file in the container's local log dirs (NMContainerLogsInfo.java:51-77).")

# ---------------------------------------------------------------- resources plugin DAOs
G = D + "gpu/"
OBJ(objects, "NmResourceInfo", D + "NMResourceInfo.java", 25, [], xml_root="nMResourceInfo",
    note="Empty base type; returned as `{}` when the plugin is unknown or returns null (e.g. FPGA plugin getNMResourceInfo() returns null: nmr:containermanager/resourceplugin/fpga/FpgaResourcePlugin.java:107).")
JNOTE = ("[INFERENCE, doc-backed] NMGpuResourceInfo/NMDeviceResourceInfo are NOT in nm:JAXBContextResolver types and have no @XmlRootElement, "
         "so Jersey falls back to a Jackson POJO provider: keys = bean getter names (no JAXB renaming), nulls ARE emitted, no root wrapper. "
         "Evidence: NodeManagerRest.html (3.4.3) 'Resources API' example shows {\"gpuDeviceInformation\": null, \"totalGpuDevices\":[{\"index\":0,\"minorNumber\":0}], \"assignedGpuDevices\":[]} and documents gpus/driverVersion/productName/uuid/minorNumber. "
         "The @XmlElement renames on GpuDeviceInformation (gpu, driver_version...) only apply to the nvidia-smi XML parse, not to this JSON.")
OBJ(objects, "NmGpuResourceInfo", G + "NMGpuResourceInfo.java", 32, [
    F("gpuDeviceInformation", "object", 33, G + "NMGpuResourceInfo.java", ref="NmGpuDeviceInformation", nullable=True,
      note="null when GPU auto-discovery is disabled (yarn.nodemanager.resource-plugins.gpu.allowed-gpu-devices != auto): GpuResourcePlugin.java:111-131"),
    F("totalGpuDevices", "object", 35, G + "NMGpuResourceInfo.java", array=True, ref="NmGpuDevice"),
    F("assignedGpuDevices", "object", 36, G + "NMGpuResourceInfo.java", array=True, ref="NmAssignedGpuDevice"),
], extends="NmResourceInfo", note=JNOTE, java=JAVA(G + "NMGpuResourceInfo.java"))
OBJ(objects, "NmGpuDeviceInformation", G + "GpuDeviceInformation.java", 33, [
    F("gpus", "object", 35, G + "GpuDeviceInformation.java", array=True, ref="NmPerGpuDeviceInformation", nullable=True, note="getGpus(); XML name 'gpu'"),
    F("driverVersion", "string", 36, G + "GpuDeviceInformation.java", note="default \"N/A\"; XML name driver_version"),
], note=JNOTE)
OBJ(objects, "NmPerGpuDeviceInformation", G + "PerGpuDeviceInformation.java", 34, [
    F("productName", "string", 36, G + "PerGpuDeviceInformation.java", note="default \"N/A\"; XML product_name"),
    F("uuid", "string", 37, G + "PerGpuDeviceInformation.java", note="default \"N/A\""),
    F("minorNumber", "int", 38, G + "PerGpuDeviceInformation.java", note="default -1; XML minor_number"),
    F("gpuUtilizations", "object", 40, G + "PerGpuDeviceInformation.java", ref="NmPerGpuUtilizations", nullable=True, note="XML name utilization"),
    F("gpuMemoryUsage", "object", 41, G + "PerGpuDeviceInformation.java", ref="NmPerGpuMemoryUsage", nullable=True, note="XML name fb_memory_usage"),
    F("temperature", "object", 42, G + "PerGpuDeviceInformation.java", ref="NmPerGpuTemperature", nullable=True),
], note=JNOTE)
OBJ(objects, "NmPerGpuUtilizations", G + "PerGpuUtilizations.java", 33, [
    F("overallGpuUtilization", "float", 43, G + "PerGpuUtilizations.java", unit="percent", note="getter returns Float (parsed from nvidia-smi '12 %' by StrToFloatBeforeSpaceAdapter); XML gpu_util"),
])
OBJ(objects, "NmPerGpuMemoryUsage", G + "PerGpuMemoryUsage.java", 30, [
    F("usedMemoryMiB", "long", 37, G + "PerGpuMemoryUsage.java", unit="MiB", note="default -1; XML used"),
    F("availMemoryMiB", "long", 47, G + "PerGpuMemoryUsage.java", unit="MiB", note="default -1; XML free"),
    F("totalMemoryMiB", "long", 55, G + "PerGpuMemoryUsage.java", unit="MiB", note="computed getter getTotalMemoryMiB(): -1 if both -1 else used+avail. Emitted by Jackson (public getter), not part of XML."),
])
OBJ(objects, "NmPerGpuTemperature", G + "PerGpuTemperature.java", 33, [
    F("currentGpuTemp", "float", 45, G + "PerGpuTemperature.java", unit="celsius", note="default Float.MIN_VALUE; XML gpu_temp"),
    F("maxGpuTemp", "float", 59, G + "PerGpuTemperature.java", unit="celsius", note="XML gpu_temp_max_threshold"),
    F("slowThresholdGpuTemp", "float", 73, G + "PerGpuTemperature.java", unit="celsius", note="XML gpu_temp_slow_threshold"),
])
C = "nmr:containermanager/resourceplugin/gpu/"
OBJ(objects, "NmGpuDevice", C + "GpuDevice.java", 26, [
    F("index", "int", 27, C + "GpuDevice.java"),
    F("minorNumber", "int", 28, C + "GpuDevice.java"),
], note=JNOTE)
OBJ(objects, "NmAssignedGpuDevice", C + "AssignedGpuDevice.java", 26, [
    F("containerId", "string", 29, C + "AssignedGpuDevice.java"),
], extends="NmGpuDevice")
OBJ(objects, "NmDeviceResourceInfo", D + "NMDeviceResourceInfo.java", 29, [
    F("totalDevices", "object", 31, D + "NMDeviceResourceInfo.java", array=True, ref="NmDevice"),
    F("assignedDevices", "object", 32, D + "NMDeviceResourceInfo.java", array=True, ref="NmAssignedDevice"),
], extends="NmResourceInfo", note="Returned by DevicePluginAdapter (pluggable device framework resources) - nmr:containermanager/resourceplugin/deviceframework/DevicePluginAdapter.java:122. " + JNOTE)
DV = "nmr:api/deviceplugin/Device.java"
OBJ(objects, "NmDevice", DV, 27, [
    F("id", "int", 35, DV), F("devPath", "string", 41, DV), F("majorNumber", "int", 47, DV),
    F("minorNumber", "int", 53, DV), F("busID", "string", 60, DV),
    F("healthy", "boolean", 111, DV, note="getter isHealthy() => Jackson key 'healthy'"),
    F("status", "string", 72, DV),
])
OBJ(objects, "NmAssignedDevice", "nmr:containermanager/resourceplugin/deviceframework/AssignedDevice.java", 30, [
    F("device", "object", 42, "nmr:containermanager/resourceplugin/deviceframework/AssignedDevice.java", ref="NmDevice"),
    F("containerId", "string", 46, "nmr:containermanager/resourceplugin/deviceframework/AssignedDevice.java"),
])

entities = [
    {"id": "nm.info", "description": "NodeManager node information (GET /ws/v1/node/info)", "roots": [{"object": "NmNodeInfo", "jsonPath": "nodeInfo", "when": []}]},
    {"id": "nm.app", "description": "one application known to the NodeManager", "roots": [{"object": "NmAppInfo", "jsonPath": "apps.app[]", "when": []}, {"object": "NmAppInfo", "jsonPath": "app", "when": []}]},
    {"id": "nm.container", "description": "one container on the NodeManager", "roots": [{"object": "NmContainerInfo", "jsonPath": "containers.container[]", "when": []}, {"object": "NmContainerInfo", "jsonPath": "container", "when": []}]},
    {"id": "nm.aux", "description": "auxiliary service loaded from the manifest", "roots": [{"object": "NmAuxiliaryServiceInfo", "jsonPath": "services.service[]", "when": ["conf:yarn.nodemanager.aux-services.manifest.enabled=true"]}]},
    {"id": "nm.gpu", "description": "GPU resource plugin state (GET /ws/v1/node/resources/yarn.io%2Fgpu)", "roots": [{"object": "NmGpuResourceInfo", "jsonPath": "", "when": ["conf:yarn.nodemanager.resource-plugins=yarn.io/gpu"]}]},
    {"id": "nm.device", "description": "device-framework resource plugin state (GET /ws/v1/node/resources/{resourcename})", "roots": [{"object": "NmDeviceResourceInfo", "jsonPath": "", "when": ["other:device plugin configured"]}]},
]

NMW = "nm:NMWebServices.java"
PROD = ["application/json; charset=utf-8", "application/xml; charset=utf-8"]
E400 = {"status": 400, "when": "invalid id / bad param", "body": "RemoteException"}
E404 = {"status": 404, "when": "unknown app/container", "body": "RemoteException"}
HOST = "http(s)://<nm-host>:<yarn.nodemanager.webapp.address, default 0.0.0.0:8042>"
resources = [
    RES("nm.info.root", "nm", "GET", "/ws/v1/node", produces=PROD, response=resp("NmNodeInfo", "nodeInfo", '{"nodeInfo":{…}}'),
        src=S("nm:NMWebServices.java", 148), note="Same body as /ws/v1/node/info. " + JSON_NOTE),
    RES("nm.info", "nm", "GET", "/ws/v1/node/info", contract="info", allow=True, produces=PROD,
        response=resp("NmNodeInfo", "nodeInfo", '{"nodeInfo":{"healthReport":"","totalVmemAllocatedContainersMB":17203,…,"nmStartupTime":1485800887841}}'),
        src=S("nm:NMWebServices.java", 155), note=JSON_NOTE),
    RES("nm.apps", "nm", "GET", "/ws/v1/node/apps", contract="apps", allow=True, produces=PROD,
        params=[P("state", doc="ApplicationState name (case-insensitive compare); invalid value => IllegalArgumentException => 400", src=S(NMW, 169)),
                P("user", doc="exact user; present-but-empty => 400 'Error: You must specify a non-empty string for the user'", src=S(NMW, 170))],
        response=resp("NmAppsInfo", "apps", '{"apps":{"app":[{"id","state","user","containerids":[…]}]}}'),
        errors=[E400], acl="when yarn.webapp.filter-entity-list-by-user=true, apps the caller cannot VIEW_APP are dropped (NMWebServices.java:195-198)",
        src=S(NMW, 164), note=JSON_NOTE),
    RES("nm.app", "nm", "GET", "/ws/v1/node/apps/{appid}", contract="apps/{id}", allow=True, produces=PROD,
        params=[P("appid", "path", required=True, src=S(NMW, 209))],
        response=resp("NmAppInfo", "app", '{"app":{"id","state","user","containerids":[…]}}'),
        errors=[E400, {"status": 404, "when": "app not in NM context ('app with id X not found')", "body": "RemoteException"}],
        src=S(NMW, 205), note="No ACL check on a single app (unlike the list)."),
    RES("nm.containers", "nm", "GET", "/ws/v1/node/containers", contract="containers", allow=True, produces=PROD,
        response=resp("NmContainersInfo", "containers", '{"containers":{"container":[{…NmContainerInfo…}]}}'),
        acl="same filter-entity-list-by-user filtering as apps; hsr.getRemoteUser() decides containerLogFiles visibility",
        src=S(NMW, 220), note="ContainerInfo is built BEFORE the ACL filter, so log dirs are listed even for hidden entries (cost only)."),
    RES("nm.container", "nm", "GET", "/ws/v1/node/containers/{containerid}", contract="containers/{containerId}", allow=True, produces=PROD,
        params=[P("containerid", "path", required=True, src=S(NMW, 256))],
        response=resp("NmContainerInfo", "container", '{"container":{…}}'),
        errors=[{"status": 400, "when": "invalid container id", "body": "RemoteException"}, {"status": 404, "when": "container not in NM context", "body": "RemoteException"}],
        src=S(NMW, 251)),
    RES("nm.container.logs", "nm", "GET", "/ws/v1/node/containers/{containerid}/logs", produces=PROD,
        params=[P("containerid", "path", required=True, src=S(NMW, 293))],
        response=resp("NmContainerLogsInfo", None, '[ {"containerLogInfo":[{"fileName","fileSize","lastModifiedTime"}],"logAggregationType":"LOCAL","containerId","nodeId"}, {…"logAggregationType":"AGGREGATED"…}* ]'),
        errors=[{"status": 400, "when": "invalid container id", "body": "RemoteException"},
                {"status": 307, "when": "local listing fails AND yarn.log.server.web-service.url set: Location=<url>/containers/<id>/logs?<query minus nm.id>&redirected_from_node=true", "body": None}],
        acl="NM view ACL via ContainerLogsUtils.checkAccess (VIEW_APP) for the local part; header X-Content-Type-Options: nosniff",
        src=S(NMW, 286),
        note="Body is a JSON ARRAY (List<ContainerLogsInfo> via GenericEntity): first element LOCAL, then one AGGREGATED element per ContainerLogMeta found in remote FS (only if aggregation exists). Key names come from LogContainerLogsInfo (@XmlElement renames). [INFERENCE] NM/JHS serialise through Jersey's default JSON list provider (not Jackson); with one log file 'containerLogInfo' may collapse to an object in 'mapped' notation - verify on live NM. AHS (Jackson) always emits arrays."),
    RES("nm.container.logs.file", "nm", "GET", "/ws/v1/node/containers/{containerid}/logs/{filename}", produces=["text/plain; charset=utf-8"],
        params=[P("containerid", "path", required=True, src=S(NMW, 376)), P("filename", "path", required=True, src=S(NMW, 378)),
                P("format", values=["text", "octet-stream"], doc="case-insensitive; default Content-Type text/plain; anything else => 400 'The valid values for the parameter : format are [text, octet-stream]'", src=S(NMW, 380)),
                P("size", doc="long bytes; long bytes; n>=0 => first n bytes, n<0 => last |n| bytes (yc:logaggregation/LogToolUtils.java:88-107); absent/empty = Long.MAX_VALUE (whole file)", src=S(NMW, 382))],
        response=resp(None, None, "text/plain: LogToolUtils header (see nm.containerlogs) + file bytes + 'End of LogType:<file>.' trailer", "text/plain; charset=utf-8"),
        src=S(NMW, 370), note="Delegates to getLogs() - identical to nm.containerlogs; both URLs exist."),
    RES("nm.containerlogs", "nm", "GET", "/ws/v1/node/containerlogs/{containerid}/{filename}", produces=["text/plain; charset=utf-8"],
        params=[P("containerid", "path", required=True, src=S(NMW, 411)), P("filename", "path", required=True, src=S(NMW, 413)),
                P("format", values=["text", "octet-stream"], doc="see nm.container.logs.file", src=S(NMW, 415)),
                P("size", doc="parseLongParam: empty => Long.MAX_VALUE; otherwise Long.parseLong (NumberFormatException => 503 via GenericExceptionHandler); n<0 => last |n| bytes, n>=0 => first n bytes", src=S(NMW, 417))],
        response=resp(None, None,
                      "text/plain body = LogToolUtils header '<Container: id on nodeId>\\nLogAggregationType: LOCAL\\n====\\nLogType:<file>\\nLogLastModifiedTime:<Times.format>\\nLogLength:<n>\\nLogContents:\\n' (yc:logaggregation/LogToolUtils.java:58-70) + raw bytes + '\\nEnd of LogType:<file>.' + ('This log file belongs to a running container (<id>) and so may not be complete.' if RUNNING) + '\\n' + '*'*(len+50) + '\\n\\n', then the same file from aggregated logs if present",
                      "text/plain; charset=utf-8"),
        errors=[{"status": 400, "when": "invalid container id (empty body)", "body": None},
                {"status": 404, "when": "NotFoundException from ContainerLogsUtils (unknown/not-yet-running container, 'Cannot find this log on the local disk.') and no yarn.log.server.web-service.url", "body": None},
                {"status": 307, "when": "NotFound AND yarn.log.server.web-service.url set: redirect to <url>/containers/<id>/logs/<filename>?<query minus nm.id>&redirected_from_node=true", "body": None},
                {"status": 500, "when": "YarnException (not authorised) / IOException opening file (e.g. file owner mismatch)", "body": None}],
        acl="VIEW_APP on the application (ContainerLogsUtils.checkAccess); SecureIOUtils.openForRead verifies file owner == app user",
        src=S(NMW, 405), note="The `size`/`format` params are the ONLY ones implemented here (no start/end/download). 'Public/Unstable' API."),
    RES("nm.resources", "nm", "GET", "/ws/v1/node/resources/{resourcename}", produces=PROD,
        params=[P("resourcename", "path", required=True, doc="resource plugin name, e.g. yarn.io/gpu (URL-encode the slash as %2F)", src=S(NMW, 542))],
        response=resp("NmGpuResourceInfo", None, "GPU: {gpuDeviceInformation|null,totalGpuDevices:[{index,minorNumber}],assignedGpuDevices:[{index,minorNumber,containerId}]}; device plugin: {totalDevices:[Device],assignedDevices:[{device,containerId}]}; unknown/no plugin: {}"),
        errors=[{"status": 503, "when": "GPU discovery YarnException (nvidia-smi failure; after N consecutive errors the plugin throws)", "body": "RemoteException"}],
        src=S(NMW, 537), note=JNOTE + " Unknown resource name returns an empty NMResourceInfo instead of 404."),
    RES("nm.auxiliaryservices", "nm", "GET", "/ws/v1/node/auxiliaryservices", produces=PROD,
        response=resp("NmAuxiliaryServicesInfo", "services", '{"services":{"service":[{"name","version","startTime"}]}}'),
        errors=[{"status": 400, "when": "'Auxiliary services manifest is not enabled'", "body": "RemoteException"}],
        when=["conf:yarn.nodemanager.aux-services.manifest.enabled=true"], src=S(NMW, 559), note=JSON_NOTE),
    RES("nm.auxiliaryservices.put", "nm", "PUT", "/ws/v1/node/auxiliaryservices", ro=False, produces=PROD,
        params=[P("body", "body", doc="AuxServiceRecords manifest (JSON/XML)", src=S(NMW, 584))],
        response=resp(None, None, "empty 200", "application/json"),
        errors=[{"status": 400, "when": "manifest disabled / null body", "body": None}, {"status": 403, "when": "caller not YARN admin", "body": None}, {"status": 500, "when": "reload failed", "body": None}],
        when=["conf:yarn.nodemanager.aux-services.manifest.enabled=true"], acl="yarn.admin.acl (ApplicationACLsManager.isAdmin)", src=S(NMW, 579), note="WRITE - listed, excluded from the product."),
    RES("nm.sysfs.put", "nm", "PUT", "/ws/v1/node/yarn/sysfs/{user}/{appId}", ro=False, produces=PROD,
        params=[P("user", "path", required=True, src=S(NMW, 611)), P("appId", "path", required=True, src=S(NMW, 612)), P("body", "body", doc="service spec text", src=S(NMW, 613))],
        response=resp(None, None, "empty 200", "application/json"),
        errors=[{"status": 403, "when": "secure cluster and remote user != {user}", "body": None}, {"status": 500, "when": "updateYarnSysFS IOException", "body": None}],
        acl="secure clusters: req.getRemoteUser() must equal {user}", src=S(NMW, 605), note="WRITE - listed, excluded from the product."),
    RES("nm.terminal", "nm", "GET", "/terminal/*", params=[], produces=["text/html", "application/javascript", "text/css"],
        response=resp(None, None, "static web-terminal assets (resourceBase classpath TERMINAL, dirAllowed=false, pathInfoOnly=true); *.template served as text/html;charset=utf-8", "text/html"),
        src=S("nm:WebServer.java", 116), note="Servlet 'Terminal' registered in WebServer.java:116 via withServlet(..., TerminalServlet.class, terminalParams, false) (internal servlet: auth filter only). Served at the NM root, NOT under /node or /ws. Used for the interactive container shell (YARN-8760)."),
    RES("nm.container.shell", "nm", "GET", "/container/container/<containerid>[/<shell>]", ro=False, params=[],
        response=resp(None, None, "WebSocket upgrade (ContainerShellWebSocket): interactive shell into a running container", "websocket"),
        when=["other:always registered (WebServer.java:114); usable only for docker runtime containers [INFERENCE]"],
        src=S("nm:ContainerShellWebSocketServlet.java", 30), note="Servlet @WebServlet urlPatterns=/container/container/* but registered at '/container/*' (WebServer.java:114). WRITE-like (executes commands) - listed, excluded."),
]

data = {"version": 1, "entities": entities, "objects": objects, "resources": resources}
hdr = "# GENERATED by parity/inventory/tools/gen_rest_nm.py - edit the script, not this file.\n# NodeManager REST (/ws/v1/node/*) from Hadoop 3.4.3 sources. Paths relative to .cluster/src-extract/.\n"
print(dump("rest-nm.yaml", data, hdr))
print(len(objects), "objects", sum(len(o["fields"]) for o in objects.values()), "fields", len(resources), "resources")
