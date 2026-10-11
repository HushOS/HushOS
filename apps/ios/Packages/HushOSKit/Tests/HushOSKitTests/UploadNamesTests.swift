import Testing
@testable import HushOSKit

/* Each picked file is placed on its own, by its position in the pick: two picks can share a name. */
struct UploadNamesTests {
    @Test func twoFreePicksOfOneNameLandUnderTwoNames() {
        var taken = ["Day 1", "Cover.jpg"]
        let placed = UploadNames.place(["Notes.txt", "Notes.txt"], existingFiles: ["Cover.jpg"], taken: &taken)
        #expect(placed == [.free("Notes.txt"), .free("Notes (2).txt")])
        #expect(taken == ["Day 1", "Cover.jpg", "Notes.txt", "Notes (2).txt"])
    }

    @Test func aDifferentCaseIsStillTheSameName() {
        var taken: [String] = []
        let placed = UploadNames.place(["notes.txt", "NOTES.TXT", "Notes.txt"], existingFiles: [], taken: &taken)
        #expect(placed == [.free("notes.txt"), .free("NOTES (2).TXT"), .free("Notes (3).txt")])
    }

    @Test func everyPickOfATakenNameIsItsOwnQuestion() {
        var taken = ["Notes.txt"]
        let placed = UploadNames.place(["Notes.txt", "Plan.txt", "notes.txt"], existingFiles: ["Notes.txt"], taken: &taken)
        #expect(placed == [.clash, .free("Plan.txt"), .clash])
    }

    @Test func aMovedNameSkipsNamesAlreadyThere() {
        // "Notes (2).txt" is in the folder, so the second pick of Notes.txt takes "(3)".
        var taken = ["Notes (2).txt"]
        let placed = UploadNames.place(["Notes.txt", "Notes.txt"], existingFiles: ["Notes (2).txt"], taken: &taken)
        #expect(placed == [.free("Notes.txt"), .free("Notes (3).txt")])
    }

    @Test func aFileMayShareItsNameWithAFolderThere() {
        var taken = ["Day 1"]
        let placed = UploadNames.place(["Day 1"], existingFiles: [], taken: &taken)
        #expect(placed == [.free("Day 1")])
    }

    @Test func freeNamesCountUpAndKeepTheExtension() {
        #expect(UploadNames.freeName("report.pdf", among: []) == "report.pdf")
        #expect(UploadNames.freeName("report.pdf", among: ["Report.PDF", "report (2).pdf"]) == "report (3).pdf")
        #expect(UploadNames.freeName("README", among: ["README"]) == "README (2)")
    }
}
