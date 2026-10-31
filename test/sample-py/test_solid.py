import unittest
import pytest
from unittest.mock import MagicMock
from cart import total, parse
from helpers.checks import assert_valid_cart


def assert_sum(values, expected):
    assert total(values) == expected


def test_sums():
    assert total([1, 2, 3]) == 6


def test_local_helper():
    assert_sum([2, 2], 4)


def test_imported_helper():
    assert_valid_cart(parse("a,b"))


def test_raises():
    with pytest.raises(ValueError, match="empty"):
        parse("")


def test_except_with_fail_guard():
    try:
        parse("")
        pytest.fail("should have raised")
    except ValueError as e:
        assert str(e) == "empty"


def test_flag_checked_after():
    raised = False
    try:
        parse("")
    except ValueError:
        raised = True
    assert raised


def test_loop_over_literal():
    for n in [1, 2, 3]:
        assert total([n]) == n


def test_range_loop():
    for i in range(5):
        assert total([i]) == i


def test_called_with():
    spy = MagicMock()
    total([1], spy)
    spy.assert_called_once_with(1)


def test_approx():
    assert total([1, 2]) == pytest.approx(3.0)


@pytest.mark.parametrize("text,expected", [("a", ["a"]), ("a,b", ["a", "b"])])
def test_parametrized(text, expected):
    assert parse(text) == expected


@pytest.mark.xfail(strict=True)
def test_strict_xfail():
    assert total([1]) == 2


def test_manual_raise():
    r = total([1, 1])
    if r != 2:
        raise AssertionError(r)


def test_does_not_raise_for_valid_input():
    parse("ok")


class CartTests(unittest.TestCase):
    def test_equal(self):
        self.assertEqual(total([1, 2]), 3)

    def test_raises(self):
        with self.assertRaises(ValueError):
            parse("")

    def test_parse(self):
        self.assertEqual(parse("a"), ["a"])
