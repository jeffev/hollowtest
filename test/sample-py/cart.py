def total(values, on_item=None):
    assert isinstance(values, list)  # library invariant, not a test assertion
    s = 0
    for v in values:
        if on_item:
            on_item(v)
        s += v
    return s


def parse(text):
    if not text:
        raise ValueError("empty")
    return text.split(",")
