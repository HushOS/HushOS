import Testing
@testable import HushOSKit

/*
 * The check guards the recovery phrase: a question that repeats a position, leaves out the
 * right word, or offers the same word twice would let someone "confirm" a phrase they never
 * saved, or block someone who did.
 */
struct RecoveryCheckTests {
    private let words = (1 ... 24).map { "word\($0)" }

    @Test func threeDifferentPositionsEachWithTheRightWordAndThreeDifferentChoices() {
        for _ in 0 ..< 500 {
            let questions = RecoveryCheck.questions(words)
            #expect(questions.count == 3)
            #expect(Set(questions.map(\.position)).count == 3)
            for question in questions {
                #expect((1 ... 24).contains(question.position))
                #expect(question.options.contains(words[question.position - 1]))
                #expect(question.options.count == 3)
                #expect(Set(question.options).count == 3)
                #expect(question.options.allSatisfy(words.contains))
            }
        }
    }

    @Test func aRepeatedWordInThePhraseIsNeverOfferedTwiceOrAsADecoyForItself() {
        // Real phrases can repeat a word; the decoys come from the other words only.
        var phrase = words
        phrase[3] = "word1"
        for _ in 0 ..< 500 {
            for question in RecoveryCheck.questions(phrase) {
                let answer = phrase[question.position - 1]
                #expect(question.options.filter { $0 == answer }.count == 1)
                #expect(Set(question.options).count == question.options.count)
            }
        }
    }

    @Test func theAnswerIsNotAlwaysInTheSamePlace() {
        var places = Set<Int>()
        for _ in 0 ..< 200 {
            for question in RecoveryCheck.questions(words) {
                places.insert(question.options.firstIndex(of: words[question.position - 1])!)
            }
        }
        #expect(places == [0, 1, 2])
    }
}
