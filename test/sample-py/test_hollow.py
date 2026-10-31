import pytest
from unittest.mock import MagicMock
from cart import total, parse


def test_empty_body():
    pass


def test_no_assertions():
    total([1, 2])


def test_tuple_assert():
    assert (total([1, 2]) == 4, "sum is wrong")


def test_compares_with_itself():
    result = total([1, 2])
    assert result == result


def test_assert_true_literal():
    total([1])
    assert True


def test_expects_raise_in_except():
    try:
        parse("")
    except ValueError as e:
        assert str(e) == "empty"


def test_except_exception_swallows_assertion():
    try:
        assert total([1, 2]) == 3
    except Exception:
        pass


def test_only_conditional():
    r = total([1])
    if r > 100:
        assert r == 101


def test_commented_out():
    r = total([1, 2])
    assert r > -1000
    # assert r == 3


def test_weak_only():
    r = parse("a")
    assert r
    assert r is not None


def test_called_only():
    spy = MagicMock()
    total([1], spy)
    spy.assert_called()


@pytest.mark.skip(reason="flaky")
def test_skipped():
    assert total([1]) == 1


@pytest.mark.xfail
def test_xfail():
    assert total([1]) == 2


class TestCart:
    def test_len_greater_than_zero(self):
        assert len(parse("a,b")) > 0
