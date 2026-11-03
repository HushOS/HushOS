import Foundation
import HushOSKit

/*
 * The extension's background session (ShareHandoff.sessionIdentifier, in the app group so
 * iOS can read the sealed parts after the extension closes). Each part that lands while
 * the extension is still open is written beside the upload for the app, and kept here so
 * the sheet can finish small uploads itself before it closes. Every task names the server's
 * upload it belongs to (`ShareHandoff.taskDescription`), and a part of any other upload than
 * the one this sheet started under that id (one since aborted and sealed again) is ignored.
 */
final class ShareUploads: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    static let shared = ShareUploads()

    private let lock = NSLock()
    private var etags: [UUID: [Int: String]] = [:]
    /* The server's upload each note's parts were started for. */
    private var uploads: [UUID: String] = [:]
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.background(withIdentifier: ShareHandoff.sessionIdentifier)
        configuration.sharedContainerIdentifier = SharedKeychain.accessGroup
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    /* Every part, described as the app's queue describes its own ("<id>|<piece>|<upload>"). */
    func start(_ note: ShareHandoff) {
        lock.withLock { uploads[note.id] = note.sealed.uploadId }
        let directory = ShareHandoff.directory(note.id)
        for part in 1 ... max(note.sealed.partCount, 1) {
            guard let address = note.sealed.urls[part], let url = URL(string: address) else { continue }
            var request = URLRequest(url: url)
            request.httpMethod = "PUT"
            let task = session.uploadTask(with: request, fromFile: directory.appendingPathComponent("part-\(part)"))
            task.taskDescription = ShareHandoff.taskDescription(note.id, part: part, upload: note.sealed.uploadId)
            task.resume()
        }
    }

    func landed(_ id: UUID) -> [Int: String] { lock.withLock { etags[id] ?? [:] } }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard error == nil, let description = task.taskDescription, let landing = ShareHandoff.landing(description),
              let response = task.response as? HTTPURLResponse, (200 ..< 300).contains(response.statusCode),
              let etag = response.value(forHTTPHeaderField: "ETag") else { return }
        // Kept here only for the upload this sheet started under that id; the file names its upload, so the app judges it too.
        lock.withLock { if uploads[landing.id] == landing.upload { etags[landing.id, default: [:]][landing.part] = etag } }
        // For the app, if it takes this upload over: the part needn't go again.
        ShareHandoff.landed(landing.id, part: landing.part, etag: etag, upload: landing.upload)
    }
}
