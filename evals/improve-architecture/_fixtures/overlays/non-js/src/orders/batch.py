from src.shared.stock import stock
from src.shared.price import total


def batch_order(order):
    if stock[order["sku"]] < order["quantity"]:
        raise ValueError("stock exhausted")
    stock[order["sku"]] -= order["quantity"]
    return {"total": total(order["price"], order["discount"])}
