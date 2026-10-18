#!/usr/bin/env python3
"""Object-table half of the RM REST inventory.

`collect_objects()` parses every DAO listed in OBJECT_SPECS with extract_dao.py (JAXB visibility rules) and returns
{objectName: {java, source, extends, xmlRoot, fields:[...]}} where each field already carries name/type/array/ref/values/
nullable/source. Hand-written knowledge (notes, `when`, units, nullability overrides) is merged afterwards from
rest_rm_meta.FIELD_META by build_rest_rm.py.
"""
import os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract_dao as X

SRC = X.ROOT
RMW = 'hadoop-yarn-server-resourcemanager/org/apache/hadoop/yarn/server/resourcemanager/webapp/'
RMS = 'hadoop-yarn-server-resourcemanager/org/apache/hadoop/yarn/server/resourcemanager/scheduler/'
SRVW = 'hadoop-yarn-server-common/org/apache/hadoop/yarn/server/webapp/'
YCW = 'hadoop-yarn-common/org/apache/hadoop/yarn/webapp/'
API = 'hadoop-yarn-api/org/apache/hadoop/yarn/api/records/'


def rmdao(n):
    return (RMW + 'dao/' + n + '.java', n)


# objectName -> (relative file, java class name (Outer.Inner allowed))
OBJECT_SPECS = {n: rmdao(n) for n in '''
ActivitiesInfo ActivityNodeInfo AllocationTagInfo AllocationTagsInfo AppActivitiesInfo AppAllocationInfo AppAttemptInfo
AppAttemptsInfo AppInfo AppPriority AppQueue AppRequestAllocationInfo AppState AppTimeoutInfo AppTimeoutsInfo AppsInfo
ApplicationStatisticsInfo ApplicationSubmissionContextInfo AutoQueueTemplatePropertiesInfo BulkActivitiesInfo
CapacitySchedulerInfo CapacitySchedulerLeafQueueInfo CapacitySchedulerQueueInfo CapacitySchedulerQueueInfoList
CapacitySchedulerHealthInfo ClusterInfo ClusterMetricsInfo ClusterUserInfo ConfigVersionInfo ContainerLaunchContextInfo
CredentialsInfo DelegationToken ExecutionTypeRequestInfo FairSchedulerInfo FairSchedulerLeafQueueInfo
FairSchedulerQueueInfo FairSchedulerQueueInfoList FifoSchedulerInfo LabelsToNodesInfo LeafQueueTemplateInfo
LocalResourceInfo LogAggregationContextInfo NewApplication NewReservation NodeAllocationInfo NodeAttributeInfo
NodeAttributesInfo NodeInfo NodeLabelInfo NodeLabelsInfo NodeToLabelsEntry NodeToLabelsEntryList NodeToLabelsInfo
NodesInfo PartitionInfo PartitionQueueCapacitiesInfo PartitionResourcesInfo QueueAclInfo QueueAclsInfo
QueueCapacitiesInfo QueueCapacityVectorEntryInfo QueueCapacityVectorInfo RMQueueAclInfo ReservationDefinitionInfo
ReservationDeleteRequestInfo ReservationDeleteResponseInfo ReservationInfo ReservationListInfo ReservationRequestInfo
ReservationRequestsInfo ReservationSubmissionRequestInfo ReservationUpdateRequestInfo ReservationUpdateResponseInfo
ResourceAllocationInfo ResourceInfo ResourceInformationsInfo ResourceOptionInfo ResourceRequestInfo
ResourceUtilizationInfo ResourcesInfo SchedulerInfo SchedulerOverviewInfo SchedulerTypeInfo StatisticsItemInfo
UserMetricsInfo UsersInfo
'''.split()}
OBJECT_SPECS.update({
    'NodeIDsInfo': (RMW + 'NodeIDsInfo.java', 'NodeIDsInfo'),
    'UserInfo': (RMS + 'capacity/UserInfo.java', 'UserInfo'),
    'LeafQueueTemplateConfItem': (RMW + 'dao/LeafQueueTemplateInfo.java', 'LeafQueueTemplateInfo.ConfItem'),
    'OperationInformation': (RMW + 'dao/CapacitySchedulerHealthInfo.java', 'CapacitySchedulerHealthInfo.OperationInformation'),
    'LastRunDetails': (RMW + 'dao/CapacitySchedulerHealthInfo.java', 'CapacitySchedulerHealthInfo.LastRunDetails'),
    # server-common (shared with AHS)
    'ContainerInfo': (SRVW + 'dao/ContainerInfo.java', 'ContainerInfo'),
    'ContainersInfo': (SRVW + 'dao/ContainersInfo.java', 'ContainersInfo'),
    'ServerAppAttemptInfo': (SRVW + 'dao/AppAttemptInfo.java', 'AppAttemptInfo'),
    'ServerAppAttemptsInfo': (SRVW + 'dao/AppAttemptsInfo.java', 'AppAttemptsInfo'),
    # hadoop-yarn-common
    'ConfInfo': (YCW + 'dao/ConfInfo.java', 'ConfInfo'),
    'ConfInfoItem': (YCW + 'dao/ConfInfo.java', 'ConfInfo.ConfItem'),
    'QueueConfigInfo': (YCW + 'dao/QueueConfigInfo.java', 'QueueConfigInfo'),
    'SchedConfUpdateInfo': (YCW + 'dao/SchedConfUpdateInfo.java', 'SchedConfUpdateInfo'),
    'RemoteException': (YCW + 'RemoteExceptionData.java', 'RemoteExceptionData'),
    # hadoop-yarn-api record serialised with JAXB PUBLIC_MEMBER defaults (no annotations)
    'ResourceInformation': (API + 'ResourceInformation.java', 'ResourceInformation'),
})

# (java simple type name, owning java class) -> object name, where a plain simple-name mapping is ambiguous
AMBIG = {
    ('AppAttemptInfo', 'ServerAppAttemptsInfo'): 'ServerAppAttemptInfo',
    ('ContainerInfo', 'ContainersInfo'): 'ContainerInfo',
    ('ConfItem', 'ConfInfo'): 'ConfInfoItem',
    ('ConfItem', 'LeafQueueTemplateInfo'): 'LeafQueueTemplateConfItem',
    ('ConfItem', 'AutoQueueTemplatePropertiesInfo'): 'LeafQueueTemplateConfItem',
    ('OperationInformation', 'CapacitySchedulerHealthInfo'): 'OperationInformation',
    ('LastRunDetails', 'CapacitySchedulerHealthInfo'): 'LastRunDetails',
    ('RemoteExceptionData', ''): 'RemoteException',
}

ENUMS = {}   # simple enum type name -> [values]; filled by _load_enums()
ENUM_SRC = {}

# enum types that are not under .cluster/src-extract (hadoop-common) -> (values, source description)
EXTERNAL_ENUMS = {
    'STATE': (['NOTINITED', 'INITED', 'STARTED', 'STOPPED'],
              'hadoop-common-3.4.3-sources.jar!org/apache/hadoop/service/Service.java:40'),
    'HAServiceState': (['INITIALIZING', 'ACTIVE', 'STANDBY', 'OBSERVER', 'STOPPING'],
                       'hadoop-common-3.4.3-sources.jar!org/apache/hadoop/ha/HAServiceProtocol.java:50'),
}

PRIMS = {
    'String': 'string', 'int': 'int', 'Integer': 'int', 'short': 'int', 'Short': 'int', 'long': 'long', 'Long': 'long',
    'float': 'float', 'Float': 'float', 'double': 'double', 'Double': 'double', 'boolean': 'boolean', 'Boolean': 'boolean',
    'URI': 'string',
}
LISTS = ('List', 'ArrayList', 'Collection', 'Set', 'HashSet', 'LinkedList', 'Iterable')
MAPS = ('Map', 'HashMap', 'LinkedHashMap', 'TreeMap', 'ConcurrentHashMap')


def _load_enums():
    want = ['YarnApplicationState', 'FinalApplicationStatus', 'LogAggregationStatus', 'RMAppAttemptState',
            'YarnApplicationAttemptState', 'NodeState', 'QueueState', 'ContainerState', 'ApplicationTimeoutType',
            'ApplicationAccessType', 'LocalResourceType', 'LocalResourceVisibility', 'ResourceTypes']
    paths = {
        'YarnApplicationState': API, 'FinalApplicationStatus': API, 'LogAggregationStatus': API,
        'RMAppAttemptState': 'hadoop-yarn-server-resourcemanager/org/apache/hadoop/yarn/server/resourcemanager/rmapp/attempt/',
        'YarnApplicationAttemptState': API, 'NodeState': API, 'QueueState': API, 'ContainerState': API,
        'ApplicationTimeoutType': API, 'ApplicationAccessType': API, 'LocalResourceType': API,
        'LocalResourceVisibility': API, 'ResourceTypes': 'hadoop-yarn-api/org/apache/hadoop/yarn/api/protocolrecords/',
    }
    for n in want:
        p = paths[n] + n + '.java'
        cl = [c for c in X.parse_file(os.path.join(SRC, p)) if c['name'] == n and c['kind'] == 'enum'][0]
        ENUMS[n] = cl['enum_values']
        ENUM_SRC[n] = '%s:%d' % (p, cl['line'])
    for n, (v, s) in EXTERNAL_ENUMS.items():
        ENUMS[n] = v
        ENUM_SRC[n] = s


def _find_class(path, dotted):
    classes = X.parse_file(os.path.join(SRC, path))
    by = {c['name']: c for c in classes}
    parts = dotted.split('.')
    cl = by[parts[-1]]
    return cl, classes


def split_generic(t):
    """'Map<String, List<X>>' -> ('Map', ['String', 'List<X>'])"""
    t = t.strip()
    m = re.match(r'([\w.]+)\s*<(.*)>$', t, re.S)
    if not m:
        return t.split('.')[-1], []
    args, depth, cur = [], 0, ''
    for ch in m.group(2):
        if ch == '<':
            depth += 1
        elif ch == '>':
            depth -= 1
        if ch == ',' and depth == 0:
            args.append(cur.strip())
            cur = ''
        else:
            cur += ch
    args.append(cur.strip())
    return m.group(1).split('.')[-1], args


def map_type(jtype, owner_java):
    """Return dict(type,array,ref,values) for a Java type expression."""
    base, args = split_generic(jtype)
    array = False
    if jtype.endswith('[]'):
        base, array = jtype[:-2].split('.')[-1], True
    if base in LISTS and args:
        array = True
        base, args = split_generic(args[0])
    if base in MAPS:
        vt = args[1] if len(args) == 2 else 'Object'
        vb, _ = split_generic(vt)
        ref = None
        if vb not in PRIMS:
            ref = AMBIG.get((vb, owner_java), vb)
        return {'type': 'map', 'array': False, 'ref': ref, 'values': [],
                'mapKey': split_generic(args[0])[0] if args else None, 'mapValue': vb}
    if base in PRIMS:
        return {'type': PRIMS[base], 'array': array, 'ref': None, 'values': []}
    if base in ENUMS:
        return {'type': 'enum', 'array': array, 'ref': None, 'values': list(ENUMS[base]), 'enumType': base}
    if base == 'EnumSet':
        return {'type': 'any', 'array': True, 'ref': None, 'values': []}
    return {'type': 'object', 'array': array, 'ref': AMBIG.get((base, owner_java), base), 'values': []}


def decap(n):
    return n[0].lower() + n[1:]


def collect_objects():
    _load_enums()
    out = {}
    for oname, (path, dotted) in OBJECT_SPECS.items():
        cl, classes = _find_class(path, dotted)
        by = {c['name']: c for c in classes}
        owner = dotted.split('.')[0] if '.' not in dotted else dotted.split('.')[0]
        access = X.effective_access(cl, by)
        if cl['extends'] and cl['extends'] not in by:
            parent = cl['extends']
        else:
            parent = cl['extends']
        jf = X.json_fields(cl, access)
        rootann = X.find_ann(cl['anns'], 'XmlRootElement')
        xml_root = None
        if rootann is not None:
            xml_root = X.ann_arg(rootann, 'name') or decap(cl['name'])
        if rootann is not None and X.ann_arg(rootann, 'name') in (None, '##default'):
            xml_root = decap(cl['name'])
        xmltype = X.find_ann(cl['anns'], 'XmlType')
        fields = []
        for jname, member, origin in jf:
            if origin == 'field':
                jt = member['type']
                line = member['line']
                init = member.get('init')
                anns = [a['name'] + ('(' + a['args'] + ')' if a['args'] else '') for a in member['anns']]
            else:
                jt = member['ret']
                line = member['line']
                init = None
                anns = []
            tm = map_type(jt, cl['name'] if '.' not in dotted else dotted.split('.')[-1] if False else cl['name'])
            # nested classes (ConfItem etc.) resolve ambiguity by the *outer* class
            if cl.get('outer'):
                tm = map_type(jt, cl['outer'])
            f = {'name': jname, 'javaName': member['name'], 'javaType': jt, 'origin': origin, 'access': access,
                 'array': tm['array'], 'type': tm['type'], 'ref': tm['ref'], 'values': tm['values'],
                 'source': '%s:%d' % (path, line), 'init': init, 'annotations': anns}
            for k in ('mapKey', 'mapValue', 'enumType'):
                if k in tm:
                    f[k] = tm[k]
            fields.append(f)
        out[oname] = {
            'java': _fqcn(path, dotted),
            'source': '%s:%d' % (path, cl['line']),
            'extends': AMBIG.get((cl['extends'], ''), cl['extends']) if cl['extends'] else None,
            'xmlRoot': xml_root,
            'xmlType': X.ann_arg(xmltype, 'name') if xmltype else None,
            'accessType': access,
            'seeAlso': (X.find_ann(cl['anns'], 'XmlSeeAlso') or {}).get('args'),
            'fields': fields,
        }
    return out


def _fqcn(path, dotted):
    p = path[:-5].split('/')
    # drop the module directory (first path component)
    pk = '.'.join(p[1:-1]) if p[0].startswith('hadoop-') else '.'.join(p[:-1])
    return pk + '.' + dotted


if __name__ == '__main__':
    objs = collect_objects()
    for n, o in objs.items():
        print(n, o['accessType'], o['xmlRoot'], o['extends'], len(o['fields']))
        for f in o['fields']:
            print('   ', f['name'], f['type'], '[]' if f['array'] else '', f['ref'] or '', f['javaType'])
