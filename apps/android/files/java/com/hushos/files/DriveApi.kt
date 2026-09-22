package com.hushos.files

import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL

class NotAuthenticated : Exception("Sign in to HushOS to see your files.")
class ApiError(val status: Int, message: String) : Exception(message)

/* The Drive API as the provider needs it, over HttpURLConnection with the shared session cookie. */
class DriveApi(private val origin: String, private val token: String) {
    private val cookieName = if (origin.startsWith("https:")) "__Host-hushos-session" else "hushos-session"

    private fun open(path: String, method: String): HttpURLConnection {
        val connection = URL("$origin/api/drive$path").openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.setRequestProperty("Cookie", "$cookieName=$token")
        connection.setRequestProperty("HushOS-Client", "android/2")
        connection.setRequestProperty("Origin", origin)
        connection.connectTimeout = 30_000
        connection.readTimeout = 60_000
        return connection
    }

    private fun finish(connection: HttpURLConnection): JSONObject {
        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
        if (status == 401 || status == 403) throw NotAuthenticated()
        if (status !in 200..299) {
            val message = runCatching { JSONObject(text).optString("message") }.getOrNull()
            throw ApiError(status, if (message.isNullOrEmpty()) "Request failed" else message)
        }
        return if (text.isEmpty()) JSONObject() else JSONObject(text)
    }

    fun get(path: String): JSONObject = finish(open(path, "GET"))

    fun post(path: String, body: JSONObject, method: String = "POST"): JSONObject {
        val connection = open(path, method)
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json")
        connection.outputStream.use { it.write(body.toString().toByteArray()) }
        return finish(connection)
    }

    fun workspace(): JSONObject = get("/workspace")

    fun children(nodeId: String, workspaceId: String, after: String?): JSONObject =
        get("/nodes/$nodeId/children?workspaceId=$workspaceId" + (after?.let { "&after=$it" } ?: ""))

    fun versionUrl(versionId: String, workspaceId: String): String =
        get("/versions/$versionId/url?workspaceId=$workspaceId").getString("url")

    fun thumbnailUrl(versionId: String, workspaceId: String): String? {
        val urls = get("/thumbnails?workspaceId=$workspaceId&versions=$versionId").getJSONArray("urls")
        return if (urls.length() > 0) urls.getJSONObject(0).getString("url") else null
    }

    /* One byte range of a stored object, from its presigned URL. */
    fun range(url: String, start: Long, end: Long): ByteArray {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.setRequestProperty("Range", "bytes=$start-$end")
        connection.connectTimeout = 30_000
        connection.readTimeout = 120_000
        val status = connection.responseCode
        if (status != 206 && status != 200) throw ApiError(status, "Range request failed")
        return connection.inputStream.use { it.readBytes() }
    }

    fun putPart(url: String, data: ByteArray): String {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.requestMethod = "PUT"
        connection.doOutput = true
        connection.setFixedLengthStreamingMode(data.size)
        connection.connectTimeout = 30_000
        connection.readTimeout = 300_000
        connection.outputStream.use { out: OutputStream -> out.write(data) }
        val status = connection.responseCode
        if (status !in 200..299) throw ApiError(status, "Part upload failed")
        return connection.getHeaderField("ETag") ?: throw ApiError(500, "The store returned no ETag")
    }

    fun allocateEpochs(workspaceId: String, count: Int): Int =
        post("/workspaces/$workspaceId/epochs", JSONObject().put("count", count)).getInt("from")

    fun createFolder(workspaceId: String, folder: JSONObject): JSONObject =
        post("/folders", JSONObject().put("workspaceId", workspaceId).put("folders", JSONArray().put(folder)))
            .getJSONArray("nodes").getJSONObject(0)

    fun rename(nodeId: String, workspaceId: String, metadataVersion: Int, keyEpoch: Int, metadataEnvelope: String): JSONObject =
        post("/nodes/$nodeId/metadata", JSONObject().put("workspaceId", workspaceId).put("metadataVersion", metadataVersion)
            .put("keyEpoch", keyEpoch).put("metadataEnvelope", metadataEnvelope)).getJSONObject("node")

    fun move(nodeId: String, workspaceId: String, parentId: String, parentKeyEpoch: Int, keyEnvelope: String): JSONObject =
        post("/nodes/$nodeId/parent", JSONObject().put("workspaceId", workspaceId).put("parentId", parentId)
            .put("parentKeyEpoch", parentKeyEpoch).put("keyEnvelope", keyEnvelope)).getJSONObject("node")

    fun trash(nodeId: String, workspaceId: String) {
        post("/nodes/$nodeId/trash", JSONObject().put("workspaceId", workspaceId))
    }

    fun beginUpload(workspaceId: String, body: JSONObject): JSONObject = post("/uploads", body.put("workspaceId", workspaceId))

    fun partUrls(uploadId: String, workspaceId: String, from: Int): JSONArray =
        get("/uploads/$uploadId/parts?workspaceId=$workspaceId&from=$from&count=64").getJSONArray("parts")

    fun completeUpload(uploadId: String, workspaceId: String, parts: JSONArray): JSONObject =
        post("/uploads/$uploadId/complete", JSONObject().put("workspaceId", workspaceId).put("parts", parts))

    fun abortUpload(uploadId: String, workspaceId: String) {
        runCatching { post("/uploads/$uploadId/abort", JSONObject().put("workspaceId", workspaceId)) }
    }
}
