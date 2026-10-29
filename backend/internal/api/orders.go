package api

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

func validateOrder(in *orderInput) error {
	in.Customer = strings.TrimSpace(in.Customer)
	if in.Customer == "" || utf8.RuneCountInString(in.Customer) > 200 {
		return invalid("customer is required (maximum 200 characters)")
	}
	if len(in.Items) == 0 || len(in.Items) > 100 {
		return invalid("An order must contain between 1 and 100 items")
	}
	seen := map[string]bool{}
	for i := range in.Items {
		item := &in.Items[i]
		item.SKU = strings.TrimSpace(item.SKU)
		if item.SKU == "" || utf8.RuneCountInString(item.SKU) > 64 {
			return invalid(fmt.Sprintf("Item %d: sku is required (maximum 64 characters)", i+1))
		}
		if item.Qty <= 0 || item.Qty > maxInteger {
			e := invalid("qty must be an integer between 1 and 2147483647")
			e.SKU = item.SKU
			return e
		}
		if seen[item.SKU] {
			e := invalid("Duplicate SKU: " + item.SKU)
			e.SKU = item.SKU
			return e
		}
		seen[item.SKU] = true
	}
	return nil
}

// All multi-product mutations take product locks in SKU order, avoiding lock
// inversions between simultaneous orders and cancellations.
func lockProducts(ctx context.Context, tx pgx.Tx, skus []string) (map[string]Product, error) {
	rows, err := tx.Query(ctx, "SELECT id,sku,price,stock,is_active FROM products WHERE sku=ANY($1) ORDER BY sku FOR UPDATE", skus)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	products := map[string]Product{}
	for rows.Next() {
		var p Product
		if err = rows.Scan(&p.ID, &p.SKU, &p.Price, &p.Stock, &p.IsActive); err != nil {
			return nil, err
		}
		products[p.SKU] = p
	}
	return products, rows.Err()
}
func (s *Server) createOrder(w http.ResponseWriter, r *http.Request) error {
	var in orderInput
	if err := decode(w, r, &in); err != nil {
		return err
	}
	if err := validateOrder(&in); err != nil {
		return err
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	skus := make([]string, len(in.Items))
	for i, item := range in.Items {
		skus[i] = item.SKU
	}
	products, err := lockProducts(r.Context(), tx, skus)
	if err != nil {
		return err
	}
	// Validate every SKU and amount before any insert, UPDATE, or sequence use.
	var total int64
	for _, item := range in.Items {
		p, ok := products[item.SKU]
		if !ok {
			e := invalid("Unknown SKU: " + item.SKU)
			e.SKU = item.SKU
			return e
		}
		if !p.IsActive {
			e := invalid("Product is inactive: " + item.SKU)
			e.SKU = item.SKU
			return e
		}
		line := p.Price * item.Qty
		if line > maxInteger-total {
			return invalid("Order total exceeds the maximum of Rp 2.147.483.647")
		}
		total += line
	}
	for _, item := range in.Items {
		p := products[item.SKU]
		if p.Stock < item.Qty {
			return insufficient(item.SKU, p.Stock)
		}
	}
	var id int64
	if err = tx.QueryRow(r.Context(), "INSERT INTO sales_orders(customer,total) VALUES($1,$2) RETURNING id", in.Customer, total).Scan(&id); err != nil {
		return err
	}
	for _, item := range in.Items {
		p := products[item.SKU]
		tag, err := tx.Exec(r.Context(), "UPDATE products SET stock=stock-$2 WHERE id=$1 AND stock>=$2", p.ID, item.Qty)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return insufficient(item.SKU, p.Stock)
		}
		if _, err = tx.Exec(r.Context(), "INSERT INTO sales_order_items(order_id,sku,qty,unit_price) VALUES($1,$2,$3,$4)", id, item.SKU, item.Qty, p.Price); err != nil {
			return err
		}
		if _, err = tx.Exec(r.Context(), "INSERT INTO stock_movements(product_id,type,qty,note,order_id) VALUES($1,'out',$2,$3,$4)", p.ID, item.Qty, fmt.Sprintf("Sale · order #%d", id), id); err != nil {
			return err
		}
	}
	order, err := readOrder(r.Context(), tx, id)
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	return writeJSON(w, 201, order)
}
func readOrder(ctx context.Context, q querier, id int64) (Order, error) {
	var o Order
	err := q.QueryRow(ctx, "SELECT id,customer,status,total,created_at,cancelled_at FROM sales_orders WHERE id=$1", id).Scan(&o.ID, &o.Customer, &o.Status, &o.Total, &o.CreatedAt, &o.CancelledAt)
	if err != nil {
		return o, err
	}
	rows, err := q.Query(ctx, "SELECT sku,qty,unit_price FROM sales_order_items WHERE order_id=$1 ORDER BY id", id)
	if err != nil {
		return o, err
	}
	defer rows.Close()
	o.Items = []OrderItem{}
	for rows.Next() {
		var i OrderItem
		if err = rows.Scan(&i.SKU, &i.Qty, &i.UnitPrice); err != nil {
			return o, err
		}
		o.Items = append(o.Items, i)
	}
	return o, rows.Err()
}
func (s *Server) getOrder(w http.ResponseWriter, r *http.Request) error {
	id, err := idParam(r)
	if err != nil {
		return err
	}
	o, err := readOrder(r.Context(), s.db, id)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, o)
}
func (s *Server) cancelOrder(w http.ResponseWriter, r *http.Request) error {
	id, err := idParam(r)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	var status string
	if err = tx.QueryRow(r.Context(), "SELECT status FROM sales_orders WHERE id=$1 FOR UPDATE", id).Scan(&status); err != nil {
		return err
	}
	if status == "CANCELLED" {
		return problem(409, "ORDER_ALREADY_CANCELLED", "This order has already been cancelled")
	}
	order, err := readOrder(r.Context(), tx, id)
	if err != nil {
		return err
	}
	skus := make([]string, len(order.Items))
	for i, item := range order.Items {
		skus[i] = item.SKU
	}
	products, err := lockProducts(r.Context(), tx, skus)
	if err != nil {
		return err
	}
	for _, item := range order.Items {
		p := products[item.SKU]
		if p.Stock+item.Qty > maxInteger {
			return problem(409, "STOCK_LIMIT", "Restoring "+item.SKU+" would exceed the maximum stock")
		}
	}
	for _, item := range order.Items {
		p := products[item.SKU]
		if _, err = tx.Exec(r.Context(), "UPDATE products SET stock=stock+$2 WHERE id=$1", p.ID, item.Qty); err != nil {
			return err
		}
		if _, err = tx.Exec(r.Context(), "INSERT INTO stock_movements(product_id,type,qty,note,order_id) VALUES($1,'in',$2,$3,$4)", p.ID, item.Qty, fmt.Sprintf("Cancellation · order #%d", id), id); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(r.Context(), "UPDATE sales_orders SET status='CANCELLED',cancelled_at=now() WHERE id=$1", id); err != nil {
		return err
	}
	order, err = readOrder(r.Context(), tx, id)
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	return writeJSON(w, 200, order)
}
func (s *Server) listOrders(w http.ResponseWriter, r *http.Request) error {
	page, limit, err := pagination(r)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	var total int64
	if err = tx.QueryRow(r.Context(), "SELECT count(*) FROM sales_orders").Scan(&total); err != nil {
		return err
	}
	rows, err := tx.Query(r.Context(), "SELECT id,customer,status,total,created_at,cancelled_at FROM sales_orders ORDER BY created_at DESC,id DESC LIMIT $1 OFFSET $2", limit, (page-1)*limit)
	if err != nil {
		return err
	}
	// List rows intentionally omit items. The detail endpoint returns snapshots.
	type orderSummary struct {
		ID          int64      `json:"id"`
		Customer    string     `json:"customer"`
		Status      string     `json:"status"`
		Total       int64      `json:"total"`
		CreatedAt   time.Time  `json:"created_at"`
		CancelledAt *time.Time `json:"cancelled_at"`
	}
	data := []orderSummary{}
	for rows.Next() {
		var o Order
		if err = rows.Scan(&o.ID, &o.Customer, &o.Status, &o.Total, &o.CreatedAt, &o.CancelledAt); err != nil {
			rows.Close()
			return err
		}
		data = append(data, orderSummary{o.ID, o.Customer, o.Status, o.Total, o.CreatedAt, o.CancelledAt})
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	return writeJSON(w, 200, map[string]interface{}{"data": data, "page": page, "limit": limit, "total": total})
}
