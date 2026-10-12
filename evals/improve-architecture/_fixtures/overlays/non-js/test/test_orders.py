import unittest
from src.orders.intake import place_order
from src.orders.batch import batch_order
from src.shared.stock import stock
from src.shared.price import total


class OrderTests(unittest.TestCase):
    def test_callers_own_the_stock_and_total_sequence(self):
        stock["book"] = 3
        order = {"sku": "book", "quantity": 1, "price": 100, "discount": 10}
        self.assertEqual(place_order(order), {"total": 90})
        self.assertEqual(batch_order(order), {"total": 90})
        self.assertEqual(stock["book"], 1)

    def test_invalid_discount_is_rejected(self):
        with self.assertRaises(ValueError):
            total(100, 101)
