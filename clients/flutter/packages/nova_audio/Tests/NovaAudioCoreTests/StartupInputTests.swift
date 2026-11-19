import XCTest
@testable import NovaAudioCore

final class StartupInputTests: XCTestCase {
    func testWarnsAfterOneSecondOfSamplesOnlyOnceAndReportsRecovery() {
        var check = StartupInputCheck()
        XCTAssertNil(check.observe(allZero: true, durationMS: 990))
        XCTAssertEqual(check.observe(allZero: true, durationMS: 10), "microphone.silent")
        XCTAssertNil(check.observe(allZero: true, durationMS: 2000))
        XCTAssertEqual(check.observe(allZero: false, durationMS: 20), "microphone.recovered")
        XCTAssertNil(check.observe(allZero: true, durationMS: 2000))
    }

    func testNonzeroInputEndsStartupCheckEvenWhenUserLaterGoesQuiet() {
        var check = StartupInputCheck()
        XCTAssertNil(check.observe(allZero: true, durationMS: 900))
        XCTAssertNil(check.observe(allZero: false, durationMS: 20))
        XCTAssertNil(check.observe(allZero: true, durationMS: 2000))
    }

    func testMutePauseDoesNotAccumulateSilenceAcrossCaptureWindows() {
        var check = StartupInputCheck()
        XCTAssertNil(check.observe(allZero: true, durationMS: 900))
        check.pause()
        XCTAssertNil(check.observe(allZero: true, durationMS: 100))
        XCTAssertEqual(check.observe(allZero: true, durationMS: 900), "microphone.silent")
        check.pause()
        XCTAssertNil(check.observe(allZero: true, durationMS: 2000))
    }

    func testEmptyOrInvalidBuffersDoNotAdvanceCheck() {
        var check = StartupInputCheck()
        for duration in [0.0, -1.0, Double.nan, Double.infinity] {
            XCTAssertNil(check.observe(allZero: true, durationMS: duration))
        }
        XCTAssertNil(check.observe(allZero: true, durationMS: 999))
        XCTAssertEqual(check.observe(allZero: true, durationMS: 1), "microphone.silent")
    }
}
