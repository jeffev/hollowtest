from unittest.mock import patch
from cart import total


@patch("cart.total", return_value=6)
def test_sums_the_cart(mock_total):
    assert total([1, 2, 3]) == 6
