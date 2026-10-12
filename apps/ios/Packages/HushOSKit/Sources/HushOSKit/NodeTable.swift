import Foundation

/* A node as the key caches know it: the same id in two workspaces is two nodes. */
public struct NodeRef: Hashable, Sendable {
    public let workspaceId: String
    public let nodeId: String

    public init(workspaceId: String, nodeId: String) {
        self.workspaceId = workspaceId.lowercased()
        self.nodeId = nodeId.lowercased()
    }
}

extension NodeView {
    public var ref: NodeRef { NodeRef(workspaceId: workspaceId, nodeId: id) }

    /* The envelope suite every client reads today; a row sealed in a later one is shown as unopenable, never guessed at. */
    static let readableEnvelopeSuite = 1

    /* Absent on rows from a server that predates the field: those are suite 1. */
    func checkEnvelopeSuite() throws {
        if let suite = envelopeSuite, suite != Self.readableEnvelopeSuite { throw DriveAPIError.newerEnvelope }
    }
}

extension Opened {
    public var ref: NodeRef { node.ref }
}

/*
 * Node keys and opened nodes by workspace and node. Keyed by node id alone, a share
 * (whose ids the server picks) could land on the id of one of the account's own
 * folders and replace its key; whatever was written there next would be sealed under
 * a key the server or the granter holds. Here an entry for a received workspace never
 * answers for the own one: lookups that know the workspace ask for it exactly, and
 * lookups by id alone (what the screens hold) take the own workspace's entry first.
 */
struct NodeTable<Value> {
    /* The account's own workspace, once known; lowercased. */
    var own: String? {
        didSet { own = own?.lowercased() }
    }
    private var entries: [NodeRef: Value] = [:]
    /* Every workspace an id has an entry in. */
    private var workspaces: [String: Set<String>] = [:]

    subscript(ref: NodeRef) -> Value? {
        get { entries[ref] }
        set {
            entries[ref] = newValue
            if newValue == nil {
                workspaces[ref.nodeId]?.remove(ref.workspaceId)
                if workspaces[ref.nodeId]?.isEmpty == true { workspaces[ref.nodeId] = nil }
            } else {
                workspaces[ref.nodeId, default: []].insert(ref.workspaceId)
            }
        }
    }

    /* By id alone: the own workspace's entry, else a received one (the lowest workspace id, so the answer is stable). */
    subscript(id: String) -> Value? {
        guard let ref = ref(for: id) else { return nil }
        return entries[ref]
    }

    func ref(for id: String) -> NodeRef? {
        let nodeId = id.lowercased()
        guard let found = workspaces[nodeId], !found.isEmpty else { return nil }
        if let own, found.contains(own) { return NodeRef(workspaceId: own, nodeId: nodeId) }
        return found.min().map { NodeRef(workspaceId: $0, nodeId: nodeId) }
    }

    /* Whether the own workspace holds this id. */
    func ownsId(_ id: String) -> Bool {
        guard let own else { return false }
        return workspaces[id.lowercased()]?.contains(own) == true
    }

    /* Every entry under `id`, in any workspace. */
    mutating func remove(id: String) {
        let nodeId = id.lowercased()
        for workspace in workspaces[nodeId] ?? [] { entries[NodeRef(workspaceId: workspace, nodeId: nodeId)] = nil }
        workspaces[nodeId] = nil
    }

    func values(in workspaceId: String) -> [String: Value] {
        let workspace = workspaceId.lowercased()
        var out: [String: Value] = [:]
        for (ref, value) in entries where ref.workspaceId == workspace { out[ref.nodeId] = value }
        return out
    }

    var values: Dictionary<NodeRef, Value>.Values { entries.values }
}
