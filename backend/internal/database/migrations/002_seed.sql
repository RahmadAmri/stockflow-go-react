INSERT INTO products (sku, name, price, stock, is_active) VALUES
('COF-001', 'Kopi Arabika Gayo · 250 g', 85000, 48, true),
('COF-002', 'Kopi Robusta Lampung · 250 g', 55000, 32, true),
('TEA-001', 'Jasmine Green Tea · 100 g', 42000, 24, true),
('TEA-002', 'Earl Grey Tea · 20 bags', 38000, 8, true),
('SUG-001', 'Organic Palm Sugar · 500 g', 32000, 60, true),
('MIL-001', 'Oat Milk · 1 L', 48000, 9, true),
('MIL-002', 'Fresh Milk · 1 L', 24000, 36, true),
('CUP-001', 'Paper Cup 12 oz · 50 pcs', 45000, 80, true),
('CUP-002', 'Ceramic Coffee Cup · 240 ml', 65000, 7, true),
('SYR-001', 'Vanilla Syrup · 750 ml', 125000, 18, true),
('SYR-002', 'Caramel Syrup · 750 ml', 125000, 0, false),
('FIL-001', 'Coffee Filter V60 · 100 pcs', 75000, 26, true),
('BEA-001', 'House Blend Espresso · 1 kg', 280000, 14, true),
('CHO-001', 'Chocolate Powder · 1 kg', 110000, 5, false);

INSERT INTO stock_movements(product_id, type, qty, note, created_at)
SELECT id, 'in', stock, 'Opening inventory', now() - interval '3 days'
FROM products WHERE stock > 0;

INSERT INTO sales_orders(customer, total, created_at) VALUES
('Kedai Senja', 0, now() - interval '2 hours'),
('Ruang Kopi', 0, now() - interval '1 hour');
INSERT INTO sales_order_items(order_id, sku, qty, unit_price) VALUES
(1, 'COF-001', 2, 85000), (1, 'SUG-001', 1, 32000), (1, 'CUP-002', 1, 65000), (1, 'CUP-001', 1, 45000), (1, 'TEA-001', 1, 42000),
(2, 'BEA-001', 1, 280000), (2, 'SYR-001', 1, 125000), (2, 'MIL-002', 2, 24000), (2, 'TEA-002', 1, 38000);
-- Totals always match the persisted item snapshots (including demo records).
UPDATE sales_orders o SET total = (SELECT sum(qty * unit_price) FROM sales_order_items WHERE order_id = o.id);
INSERT INTO stock_movements(product_id, type, qty, note, order_id, created_at)
SELECT p.id, 'out', i.qty, 'Sample sale', i.order_id, o.created_at
FROM sales_order_items i JOIN products p ON p.sku = i.sku JOIN sales_orders o ON o.id = i.order_id;
UPDATE products p SET stock = stock - s.qty FROM
(SELECT sku, sum(qty)::integer AS qty FROM sales_order_items GROUP BY sku) s WHERE p.sku = s.sku;
