import XCTest
@testable import NovaAudioCore

final class CallPiPTests: XCTestCase {
    func testDismissalSuppressesAutomaticReentryUntilExplicitRequest() {
        var call = CallPiPLifetime()
        call.start("one")
        XCTAssertFalse(call.automatic)
        call.markReady("one")
        XCTAssertTrue(call.automatic)
        call.dismiss("one")
        call.markReady("one")
        XCTAssertFalse(call.automatic)
        XCTAssertTrue(call.request("one"))
        XCTAssertTrue(call.automatic)
    }

    func testLateCallbacksCannotChangeNextCallOrReenableEndedCall() {
        var call = CallPiPLifetime()
        call.start("old")
        call.markReady("old")
        call.start("new")
        call.markReady("old")
        XCTAssertFalse(call.automatic)
        call.markReady("new")
        call.dismiss("old")
        call.end("old")
        XCTAssertTrue(call.automatic)
        XCTAssertFalse(call.request("old"))
        call.end("new")
        call.markReady("new")
        XCTAssertFalse(call.request("new"))
        XCTAssertFalse(call.automatic)
    }
}
