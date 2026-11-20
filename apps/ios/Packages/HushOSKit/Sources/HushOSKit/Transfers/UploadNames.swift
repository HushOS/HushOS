import Foundation

/*
 * Where each picked file's name lands in its destination folder, worked out per pick in
 * pick order, never by name: two picked files can share a name (chosen from different
 * folders), and each needs its own answer and its own name.
 */
public enum UploadNames {
    public enum Placement: Equatable, Sendable {
        /* Nothing of this name is there: it goes under this name, its own or the next free one. */
        case free(String)
        /* A file of this name (whatever its case) is there already, and the person is asked about it. */
        case clash
    }

    /*
     * For each picked name, in order: a clash when a file of that name is in the folder, else
     * free. A free name an earlier pick already took gets the next "(n)" name instead, so two
     * picked files never land under one name; there is nothing there to replace, so it isn't
     * asked about. `taken` holds every name in the folder (files and folders) and comes back
     * with the free names added, for the kept-both names suggested next.
     */
    public static func place(_ names: [String], existingFiles: [String], taken: inout [String]) -> [Placement] {
        let files = Set(existingFiles.map { $0.lowercased() })
        // Only another pick moves a name on: a file may still share its name with a folder there.
        var picked: Set<String> = []
        return names.map { name in
            if files.contains(name.lowercased()) { return .clash }
            let free = picked.contains(name.lowercased()) ? freeName(name, among: taken) : name
            picked.insert(free.lowercased())
            taken.append(free)
            return .free(free)
        }
    }

    /* "report.pdf" becomes "report (2).pdf", then "(3)", until the name is free (whatever its case). */
    public static func freeName(_ name: String, among taken: [String]) -> String {
        let lower = Set(taken.map { $0.lowercased() })
        guard lower.contains(name.lowercased()) else { return name }
        let ext = (name as NSString).pathExtension
        let stem = ext.isEmpty ? name : (name as NSString).deletingPathExtension
        for n in 2 ... 999 {
            let candidate = ext.isEmpty ? "\(stem) (\(n))" : "\(stem) (\(n)).\(ext)"
            if !lower.contains(candidate.lowercased()) { return candidate }
        }
        return "\(stem) \(UUID().uuidString.prefix(6))\(ext.isEmpty ? "" : ".\(ext)")"
    }
}
