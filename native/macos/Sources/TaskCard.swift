/// Pure helpers for the multi-task card and its menu, kept in step with
/// can_dismiss_errors / task_line in runtime/helper.py.
enum TaskCard {
    /// Offer "忽略出错提醒" only while an error is on screen.
    static func canDismissErrors(statusState: String, tasks: [[String: Any]]) -> Bool {
        statusState == "ERROR" || tasks.contains { ($0["state"] as? String) == "ERROR" }
    }

    /// One row of the card: state, source product, then what it is.
    static func line(stateLabel: String, task: [String: Any]) -> String {
        let label = ["project", "task", "message"].lazy.compactMap { text(task[$0]) }.first ?? stateLabel
        return [stateLabel, text(task["source"]), label].compactMap { $0 }.joined(separator: " · ")
    }

    private static func text(_ value: Any?) -> String? {
        guard let value = value as? String, !value.isEmpty else { return nil }
        return value
    }
}
