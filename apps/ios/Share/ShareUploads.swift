import Foundation
import HushOSKit

/*
 * The extension's background session (ShareHandoff.sessionIdentifier, in the app group so
 * iOS can read the sealed parts after the extension closes). Each part that lands while
 * the extension is still open is written beside the upload for the app, and kept here so
 * the sheet can finish small uploads itself before it closes.
 */
final class ShareUploads: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    static let shared = ShareUploads()

    private let lock = NSLock()
    private var etags: [UUID: [Int: String]] = [:]
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.background(withIdentifier: ShareHandoff.sessionIdentifier)
        configuration.sharedContainerIdentifier = SharedKeychain.accessGroup
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    /* Every part, described as the app's queue describes its own ("<id>|<piece>"). */
    func start(_ note: ShareHandoff) {
        let directory = ShareHandoff.directory(note.id)
        for part in 1 ... max(note.sealed.partCount, 1) {
            guard let address = note.sealed.urls[part], let url = URL(string: address) else { continue }
            var request = URLRequest(url: url)
            request.httpMethod = "PUT"
            let task = session.uploadTask(with: request, fromFile: directory.appendingPathComponent("part-\(part)"))
            task.taskDescription = "\(note.id.uuidString)|\(part - 1)"
            task.resume()
        }
    }

    func landed(_ id: UUID) -> [Int: String] { lock.withLock { etags[id] ?? [:] } }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard error == nil, let description = task.taskDescription else { return }
        let fields = description.split(separator: "|")
        guard fields.count == 2, let id = UUID(uuidString: String(fields[0])), let piece = Int(fields[1]),
              let response = task.response as? HTTPURLResponse, (200 ..< 300).contains(response.statusCode),
              let etag = response.value(forHTTPHeaderField: "ETag") else { return }
        lock.withLock { etags[id, default: [:]][piece + 1] = etag }
        // For the app, if it takes this upload over: the part needn't go again.
        ShareHandoff.landed(id, part: piece + 1, etag: etag)
    }
}
