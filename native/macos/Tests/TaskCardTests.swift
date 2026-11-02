import XCTest
@testable import BigFishCore

/// Mirrors runtime/tests/test_helper_dismiss.py so both helpers agree.
final class TaskCardTests: XCTestCase {
    func testDismissIsOfferedWhileTheStatusIsAnError() {
        XCTAssertTrue(TaskCard.canDismissErrors(statusState: "ERROR", tasks: []))
    }

    func testDismissIsOfferedWhenAnyTaskHasFailed() {
        let tasks: [[String: Any]] = [["state": "WORKING"], ["state": "ERROR"]]
        XCTAssertTrue(TaskCard.canDismissErrors(statusState: "WORKING", tasks: tasks))
    }

    func testDismissIsHiddenWithoutAnError() {
        let tasks: [[String: Any]] = [["state": "WORKING"]]
        XCTAssertFalse(TaskCard.canDismissErrors(statusState: "IDLE", tasks: tasks))
    }

    func testLineNamesTheSourceProduct() {
        let task: [String: Any] = ["source": "Cursor", "project": "shop"]
        XCTAssertEqual(TaskCard.line(stateLabel: "工作中", task: task), "工作中 · Cursor · shop")
    }

    func testLineFallsBackToTaskThenMessageThenState() {
        XCTAssertEqual(TaskCard.line(stateLabel: "工作中", task: ["task": "编辑"]), "工作中 · 编辑")
        XCTAssertEqual(TaskCard.line(stateLabel: "工作中", task: ["message": "嗯"]), "工作中 · 嗯")
        XCTAssertEqual(TaskCard.line(stateLabel: "工作中", task: [:]), "工作中 · 工作中")
    }

    func testEmptyFieldsAreSkipped() {
        let task: [String: Any] = ["source": "", "project": "", "task": "编辑"]
        XCTAssertEqual(TaskCard.line(stateLabel: "工作中", task: task), "工作中 · 编辑")
    }
}
