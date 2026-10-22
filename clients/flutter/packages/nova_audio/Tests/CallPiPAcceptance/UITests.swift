import XCTest

final class CallPiPAcceptance: XCTestCase {
    func testSecondCallCanStartPiP() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        let events = app.staticTexts["events"]
        app.buttons["Compact"].tap()
        for call in 1...2 {
            app.buttons["Start"].tap()
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                events.exists && events.label.components(separatedBy: "pipReady").count - 1 >= call
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 10), .completed)
            app.buttons["Float"].tap()
            let active = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                events.label.components(separatedBy: "pipActive").count - 1 >= call
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [active], timeout: 10), .completed)
            app.buttons["End"].tap()
        }
    }

    func testAutomaticPiPWithMicrophoneAndCompactSource() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        app.buttons["Start"].tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.alerts.buttons.matching(NSPredicate(format: "label IN %@", ["Allow", "允许", "好", "OK"])).firstMatch
        if allow.waitForExistence(timeout: 3) { allow.tap() }
        let events = app.staticTexts["events"]
        XCTAssertTrue(events.waitForExistence(timeout: 5))
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS 'pipReady'"), object: events)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 10), .completed)
        app.buttons["Compact"].tap()
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 4)
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Cross-app PiP with compact native source"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        print("PIP_SPRINGBOARD_TREE\n" + springboard.debugDescription)
        app.activate()
        XCTAssertTrue(events.waitForExistence(timeout: 5))
        XCTAssertTrue(events.label.contains("pipActive"), events.label)
        XCTAssertTrue(events.label.contains("backgroundCapturePassed"), events.label)
        app.buttons["End"].tap()
        XCTAssertTrue(events.label.contains("ended"))
    }
}
