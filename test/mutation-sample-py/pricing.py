def subtotal(items):
    return sum(item["price"] * item["qty"] for item in items)


def shipping(total):
    if total >= 100:
        return 0
    return 15


def discount(total, coupon):
    if coupon == "HALF" and total > 50:
        return total / 2
    return total


def loyalty_bonus(points):
    if points > 1000:
        return points * 0.1
    return 0
