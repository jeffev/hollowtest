from pricing import discount, shipping, subtotal


# solid: these fail if subtotal or shipping break
def test_subtotal_multiplies_price_by_quantity():
    assert subtotal([{"price": 10, "qty": 3}, {"price": 5, "qty": 1}]) == 35


def test_free_shipping_from_100():
    assert shipping(100) == 0
    assert shipping(99.99) == 15


# hollow: discount() is "covered" without checking the result
def test_discount_works():
    result = discount(80, "HALF")
    assert result
