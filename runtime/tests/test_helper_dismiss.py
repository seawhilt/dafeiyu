import unittest

from runtime.helper import can_dismiss_errors, task_line


class CanDismissErrorsTests(unittest.TestCase):
    def test_offered_when_the_bubble_shows_an_error(self) -> None:
        self.assertTrue(can_dismiss_errors("ERROR", []))

    def test_offered_when_an_error_is_only_in_the_task_list(self) -> None:
        self.assertTrue(can_dismiss_errors("WORKING", [{"state": "WORKING"}, {"state": "ERROR"}]))

    def test_hidden_without_an_error(self) -> None:
        self.assertFalse(can_dismiss_errors("WORKING", [{"state": "THINKING"}]))


class TaskLineTests(unittest.TestCase):
    def test_names_the_source_product(self) -> None:
        self.assertEqual(task_line("出错", {"source": "Claude", "project": "short-manage"}), "出错 · Claude · short-manage")

    def test_falls_back_without_source_or_project(self) -> None:
        self.assertEqual(task_line("思考中", {"message": "想想"}), "思考中 · 想想")
        self.assertEqual(task_line("思考中", {}), "思考中 · 思考中")


if __name__ == "__main__":
    unittest.main()
