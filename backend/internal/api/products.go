package api

import (
	"context"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

const productColumns = `p.id,p.sku,p.name,p.price,p.stock,p.is_active,p.created_at,
    (SELECT max(m.created_at) FROM stock_movements m WHERE m.product_id=p.id)`

func scanProduct(row pgx.Row) (Product, error) {
	var p Product
	err := row.Scan(&p.ID, &p.SKU, &p.Name, &p.Price, &p.Stock, &p.IsActive, &p.CreatedAt, &p.LastMovementAt)
	return p, err
}
func readProduct(ctx context.Context, q querier, id int64) (Product, error) {
	return scanProduct(q.QueryRow(ctx, "SELECT "+productColumns+" FROM products p WHERE p.id=$1", id))
}
func validateProduct(in *productInput) error {
	in.SKU = strings.TrimSpace(in.SKU)
	in.Name = strings.TrimSpace(in.Name)
	fields := map[string]string{}
	if utf8.RuneCountInString(in.SKU) < 1 || utf8.RuneCountInString(in.SKU) > 64 {
		fields["sku"] = "SKU is required (maximum 64 characters)"
	}
	if utf8.RuneCountInString(in.Name) < 1 || utf8.RuneCountInString(in.Name) > 200 {
		fields["name"] = "Name is required (maximum 200 characters)"
	}
	if in.Price == nil || *in.Price < 0 || *in.Price > maxInteger {
		fields["price"] = "Price must be an integer between 0 and 2147483647"
	}
	if len(fields) > 0 {
		return &apiError{Status: 400, Code: "VALIDATION_ERROR", Message: "Please correct the product fields", Fields: fields}
	}
	return nil
}
func (s *Server) listProducts(w http.ResponseWriter, r *http.Request) error {
	page, limit, err := pagination(r)
	if err != nil {
		return err
	}
	search := strings.TrimSpace(r.URL.Query().Get("search"))
	filter := r.URL.Query().Get("filter")
	if filter != "" && filter != "all" && filter != "active" && filter != "inactive" && filter != "low" {
		return invalid("filter must be all, active, inactive, or low")
	}
	// strpos treats wildcard characters as literal search text.
	where := ` FROM products p WHERE ($1='' OR strpos(lower(p.sku),lower($1))>0 OR strpos(lower(p.name),lower($1))>0)
    AND ($2 IN ('','all') OR ($2='active' AND p.is_active) OR ($2='inactive' AND NOT p.is_active) OR ($2='low' AND p.stock<=10))`
	tx, err := s.db.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	var total int64
	if err = tx.QueryRow(r.Context(), "SELECT count(*)"+where, search, filter).Scan(&total); err != nil {
		return err
	}
	rows, err := tx.Query(r.Context(), "SELECT "+productColumns+where+" ORDER BY p.id LIMIT $3 OFFSET $4", search, filter, limit, (page-1)*limit)
	if err != nil {
		return err
	}
	data := []Product{}
	for rows.Next() {
		p, err := scanProduct(rows)
		if err != nil {
			rows.Close()
			return err
		}
		data = append(data, p)
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
func (s *Server) createProduct(w http.ResponseWriter, r *http.Request) error {
	var in productInput
	if err := decode(w, r, &in); err != nil {
		return err
	}
	if err := validateProduct(&in); err != nil {
		return err
	}
	active := true
	if in.IsActive != nil {
		active = *in.IsActive
	}
	var p Product
	err := s.db.QueryRow(r.Context(), `INSERT INTO products(sku,name,price,is_active) VALUES($1,$2,$3,$4)
        RETURNING id,sku,name,price,stock,is_active,created_at`, in.SKU, in.Name, *in.Price, active).Scan(&p.ID, &p.SKU, &p.Name, &p.Price, &p.Stock, &p.IsActive, &p.CreatedAt)
	if err != nil {
		return err
	}
	return writeJSON(w, 201, p)
}
func (s *Server) updateProduct(w http.ResponseWriter, r *http.Request) error {
	id, err := idParam(r)
	if err != nil {
		return err
	}
	var in productInput
	if err = decode(w, r, &in); err != nil {
		return err
	}
	if err = validateProduct(&in); err != nil {
		return err
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	var oldSKU string
	var active bool
	if err = tx.QueryRow(r.Context(), "SELECT sku,is_active FROM products WHERE id=$1 FOR UPDATE", id).Scan(&oldSKU, &active); err != nil {
		return err
	}
	if oldSKU != in.SKU {
		var history bool
		if err = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM stock_movements WHERE product_id=$1) OR EXISTS(SELECT 1 FROM sales_order_items WHERE sku=$2)", id, oldSKU).Scan(&history); err != nil {
			return err
		}
		if history {
			return problem(409, "SKU_HAS_HISTORY", "A SKU with history cannot be changed. Edit the name or deactivate the product instead.")
		}
	}
	if in.IsActive != nil {
		active = *in.IsActive
	}
	if _, err = tx.Exec(r.Context(), "UPDATE products SET sku=$2,name=$3,price=$4,is_active=$5 WHERE id=$1", id, in.SKU, in.Name, *in.Price, active); err != nil {
		return err
	}
	p, err := readProduct(r.Context(), tx, id)
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	return writeJSON(w, 200, p)
}
func (s *Server) deleteProduct(w http.ResponseWriter, r *http.Request) error {
	id, err := idParam(r)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	var sku string
	if err = tx.QueryRow(r.Context(), "SELECT sku FROM products WHERE id=$1 FOR UPDATE", id).Scan(&sku); err != nil {
		return err
	}
	var history bool
	if err = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM stock_movements WHERE product_id=$1) OR EXISTS(SELECT 1 FROM sales_order_items WHERE sku=$2)", id, sku).Scan(&history); err != nil {
		return err
	}
	if history {
		return problem(409, "PRODUCT_HAS_HISTORY", "This product has history and cannot be deleted. Deactivate it instead.")
	}
	if _, err = tx.Exec(r.Context(), "DELETE FROM products WHERE id=$1", id); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}
func (s *Server) adjustStock(w http.ResponseWriter, r *http.Request) error {
	id, err := idParam(r)
	if err != nil {
		return err
	}
	var in stockInput
	if err = decode(w, r, &in); err != nil {
		return err
	}
	if in.Type != "in" && in.Type != "out" {
		return invalid("type must be in or out")
	}
	if in.Qty <= 0 || in.Qty > maxInteger {
		return invalid("qty must be an integer between 1 and 2147483647")
	}
	if utf8.RuneCountInString(in.Note) > 1000 {
		return invalid("note must be at most 1000 characters")
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	var stock int64
	var sku string
	if err = tx.QueryRow(r.Context(), "SELECT sku,stock FROM products WHERE id=$1 FOR UPDATE", id).Scan(&sku, &stock); err != nil {
		return err
	}
	delta := in.Qty
	if in.Type == "out" {
		if stock < in.Qty {
			return insufficient(sku, stock)
		}
		delta = -delta
	}
	if stock+delta > maxInteger {
		return problem(409, "STOCK_LIMIT", "Stock would exceed the maximum of 2147483647")
	}
	if _, err = tx.Exec(r.Context(), "UPDATE products SET stock=stock+$2 WHERE id=$1 AND stock::bigint+$2 BETWEEN 0 AND 2147483647", id, delta); err != nil {
		return err
	}
	if _, err = tx.Exec(r.Context(), "INSERT INTO stock_movements(product_id,type,qty,note) VALUES($1,$2,$3,$4)", id, in.Type, in.Qty, strings.TrimSpace(in.Note)); err != nil {
		return err
	}
	p, err := readProduct(r.Context(), tx, id)
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	return writeJSON(w, 200, p)
}
func (s *Server) movements(w http.ResponseWriter, r *http.Request) error {
	id, err := idParam(r)
	if err != nil {
		return err
	}
	if _, err = readProduct(r.Context(), s.db, id); err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), "SELECT id,product_id,type,qty,note,order_id,created_at FROM stock_movements WHERE product_id=$1 ORDER BY created_at DESC,id DESC", id)
	if err != nil {
		return err
	}
	defer rows.Close()
	data := []Movement{}
	for rows.Next() {
		var m Movement
		if err = rows.Scan(&m.ID, &m.ProductID, &m.Type, &m.Qty, &m.Note, &m.OrderID, &m.CreatedAt); err != nil {
			return err
		}
		data = append(data, m)
	}
	if err = rows.Err(); err != nil {
		return err
	}
	return writeJSON(w, 200, map[string]interface{}{"data": data})
}
func (s *Server) summary(w http.ResponseWriter, r *http.Request) error {
	var total, active, low int64
	var value string
	err := s.db.QueryRow(r.Context(), `SELECT count(*),count(*) FILTER(WHERE is_active),coalesce(sum(price::bigint*stock),0)::text,count(*) FILTER(WHERE stock<=10) FROM products`).Scan(&total, &active, &value, &low)
	if err != nil {
		return err
	}
	// Decimal string keeps the sum exact beyond JavaScript's safe integer range.
	return writeJSON(w, 200, map[string]interface{}{"total_products": total, "active_products": active, "total_stock_value": value, "low_stock_count": low})
}
