import CoreGraphics
import XCTest
@testable import BigFishCore

final class PetGeometryTests: XCTestCase {
    func testDraggingFarOffAnyEdgeLeavesCharacterGrabbable() {
        let screen = CGRect(x: -1920, y: 50, width: 1920, height: 1080)
        let size = CGSize(width: 190, height: 250)
        for point in [CGPoint(x: -9999, y: -9999), CGPoint(x: 9999, y: 9999)] {
            let placed = PetGeometry.clamp(point, petSize: size, screen: screen)
            let visible = CGRect(origin: placed, size: size).intersection(screen)
            XCTAssertGreaterThanOrEqual(visible.width, size.width * 0.35 - 0.001)
            XCTAssertGreaterThanOrEqual(visible.height, size.height * 0.35 - 0.001)
        }
    }

    func testPartialPositionSurvivesRestoreAndCardResize() {
        let screen = CGRect(x: 0, y: 0, width: 1512, height: 982)
        let point = CGPoint(x: -90, y: -100)
        XCTAssertEqual(PetGeometry.clamp(point, petSize: CGSize(width: 190, height: 250), screen: screen), point)
    }

    func testOnlyTheCharacterAndCardStayInteractive() {
        let pet = CGRect(x: 25, y: 150, width: 219, height: 183)
        let card = CGRect(x: 14, y: 7, width: 364, height: 120)

        XCTAssertTrue(PetGeometry.isInteractive(CGPoint(x: 100, y: 200), pet: pet, bubble: card))
        XCTAssertTrue(PetGeometry.isInteractive(CGPoint(x: 100, y: 50), pet: pet, bubble: card))
        // The transparent margin left of the small character must pass through.
        XCTAssertFalse(PetGeometry.isInteractive(CGPoint(x: 10, y: 200), pet: pet, bubble: card))
        // The empty gap between the card and the character must pass through too.
        XCTAssertFalse(PetGeometry.isInteractive(CGPoint(x: 100, y: 135), pet: pet, bubble: card))
        // Without a visible card only the character remains a hit target.
        XCTAssertFalse(PetGeometry.isInteractive(CGPoint(x: 100, y: 50), pet: pet, bubble: nil))
    }

    func testInteractiveEdgeToleratesAFractionalPoint() {
        let pet = CGRect(x: 10, y: 10, width: 100, height: 100)
        XCTAssertTrue(PetGeometry.isInteractive(CGPoint(x: 9.5, y: 10), pet: pet, bubble: nil))
        XCTAssertFalse(PetGeometry.isInteractive(CGPoint(x: 8, y: 10), pet: pet, bubble: nil))
    }

    func testADropBySideOfTheScreenDocksThere() {
        let screen = CGRect(x: 0, y: 0, width: 1000, height: 800)
        XCTAssertEqual(PetGeometry.dockEdge(pet: CGRect(x: -40, y: 100, width: 200, height: 220), screen: screen), "left")
        XCTAssertEqual(PetGeometry.dockEdge(pet: CGRect(x: 790, y: 100, width: 200, height: 220), screen: screen), "right")
        XCTAssertNil(PetGeometry.dockEdge(pet: CGRect(x: 400, y: 100, width: 200, height: 220), screen: screen))
    }

    func testADockedPetShowsOnlyItsHead() {
        let screen = CGRect(x: 0, y: 0, width: 1000, height: 800)
        let size = CGSize(width: 200, height: 220)
        // Turned a quarter, the pet spans its height across the screen side.
        let left = PetGeometry.dockedX(edge: "left", petSize: size, screen: screen)
        XCTAssertEqual(left + size.width / 2 + size.height / 2, 220 * PetGeometry.dockPeek, accuracy: 0.001)
        let right = PetGeometry.dockedX(edge: "right", petSize: size, screen: screen)
        XCTAssertEqual(1000 - (right + size.width / 2 - size.height / 2), 220 * PetGeometry.dockPeek, accuracy: 0.001)
        XCTAssertEqual(PetGeometry.dockAngle(edge: "left"), 90)
        XCTAssertEqual(PetGeometry.dockAngle(edge: "right"), -90)
        XCTAssertEqual(PetGeometry.dockAngle(edge: nil), 0)
    }

    func testTiltLeansWithTheDragAndIsCapped() {
        XCTAssertEqual(PetGeometry.tilt(forSpeed: 400), 5)
        XCTAssertEqual(PetGeometry.tilt(forSpeed: -400), -5)
        XCTAssertEqual(PetGeometry.tilt(forSpeed: 99_999), PetGeometry.maxTilt)
    }

    // MARK: - Display seams

    private let leftScreen = CGRect(x: 0, y: 0, width: 1000, height: 800)
    private let rightScreen = CGRect(x: 1000, y: 0, width: 1000, height: 800)

    func testOnlyRealDisplayEdgesCountAsDockSides() {
        let screens = [leftScreen, rightScreen]
        let leftEdges = PetGeometry.outerEdges(of: leftScreen, among: screens)
        let rightEdges = PetGeometry.outerEdges(of: rightScreen, among: screens)
        // The inner sides are seams, the outer sides are real display edges.
        XCTAssertTrue(leftEdges.left)
        XCTAssertFalse(leftEdges.right)
        XCTAssertFalse(rightEdges.left)
        XCTAssertTrue(rightEdges.right)
    }

    func testADropAtTheSeamDoesNotDock() {
        let edges = PetGeometry.outerEdges(of: leftScreen, among: [leftScreen, rightScreen])
        // Dropped against the inner side, the pet must stay where it is
        // instead of sliding between the two displays.
        XCTAssertNil(PetGeometry.dockEdge(
            pet: CGRect(x: 810, y: 100, width: 200, height: 220),
            screen: leftScreen,
            outerEdges: edges
        ))
        // The real outer side still docks.
        XCTAssertEqual(PetGeometry.dockEdge(
            pet: CGRect(x: -40, y: 100, width: 200, height: 220),
            screen: leftScreen,
            outerEdges: edges
        ), "left")
    }

    func testScreensStackedVerticallyKeepTheirSideEdges() {
        let upper = CGRect(x: 0, y: 800, width: 1000, height: 800)
        let lower = CGRect(x: 0, y: 0, width: 1000, height: 800)
        for edges in [
            PetGeometry.outerEdges(of: lower, among: [upper, lower]),
            PetGeometry.outerEdges(of: upper, among: [upper, lower]),
        ] {
            XCTAssertTrue(edges.left)
            XCTAssertTrue(edges.right)
        }
    }

    func testASingleScreenKeepsBothDockSides() {
        let edges = PetGeometry.outerEdges(of: leftScreen, among: [leftScreen])
        XCTAssertTrue(edges.left)
        XCTAssertTrue(edges.right)
    }

    // MARK: - Tilt allowance

    func testTiltAllowanceCoversTheTurnedBoundingBox() {
        let size = CGSize(width: 412, height: 344)
        let angle = PetGeometry.maxTilt * .pi / 180
        let turned = size.width * sin(angle) + size.height * cos(angle)
        XCTAssertEqual(
            PetGeometry.tiltAllowance(petSize: size),
            (turned - size.height) / 2,
            accuracy: 0.001
        )
    }

    func testAZeroSizedPetNeedsNoTiltAllowance() {
        XCTAssertEqual(PetGeometry.tiltAllowance(petSize: .zero), 0)
    }
}
