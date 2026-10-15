def total(price, discount):
    if price < 0 or discount < 0 or discount > price:
        raise ValueError("invalid price or discount")
    return price - discount
