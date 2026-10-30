import unittest

from runtime.helper import can_dismiss_errors


class CanDismissErrorsTests(unittest.TestCase):
    def test_offered_when_claude_shows_an_error(self) -> None:
        self.assertTrue(can_dismiss_errors("claude", "ERROR", []))

    def test_offered_when_an_error_is_only_in_the_task_list(self) -> None:
        tasks = [{"state": "WORKING"}, {"state": "ERROR"}]
        self.assertTrue(can_dismiss_errors("claude", "WORKING", tasks))

    def test_hidden_without_an_error(self) -> None:
        self.assertFalse(can_dismiss_errors("claude", "WORKING", [{"state": "THINKING"}]))

    def test_hidden_for_providers_the_daemon_cannot_clear(self) -> None:
        self.assertFalse(can_dismiss_errors("deepseek", "ERROR", []))
        self.assertFalse(can_dismiss_errors("", "ERROR", []))


if __name__ == "__main__":
    unittest.main()
