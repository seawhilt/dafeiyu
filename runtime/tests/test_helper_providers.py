import unittest

from runtime.helper import parse_providers


class ParseProvidersTests(unittest.TestCase):
    def test_reads_provider_list_and_active_provider(self) -> None:
        message = {
            "providers": [{"id": "claude", "label": "Claude"}, {"id": "deepseek"}, {"label": "no id"}, "bad"],
            "provider": "deepseek",
        }
        providers, provider = parse_providers(message, [], "")
        self.assertEqual(providers, [("claude", "Claude"), ("deepseek", "deepseek")])
        self.assertEqual(provider, "deepseek")

    def test_missing_fields_keep_current_values(self) -> None:
        current = [("claude", "Claude")]
        self.assertEqual(parse_providers({"scale": 1}, current, "claude"), (current, "claude"))

    def test_null_provider_clears_selection(self) -> None:
        self.assertEqual(parse_providers({"providers": [], "provider": None}, [("claude", "Claude")], "claude"), ([], ""))


if __name__ == "__main__":
    unittest.main()
