package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"stockflow/backend/internal/database"
)

// Every integration test gets an isolated schema in a REAL PostgreSQL database.
// No application tables are truncated or dropped; cleanup removes only our schema.
func emptyTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set TEST_DATABASE_URL to run real PostgreSQL integration tests")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("stockflow_test_%d", time.Now().UnixNano())
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	config.MaxConns = 25
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, err := admin.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
		admin.Close()
		if err != nil {
			t.Error(err)
		}
	})
	return pool
}

func testDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool := emptyTestDB(t)
	sql, err := database.Migrations.ReadFile("migrations/001_schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(context.Background(), string(sql)); err != nil {
		t.Fatal(err)
	}
	return pool
}

func TestMigrationsSeedOnceAndReconcile(t *testing.T) {
	db := emptyTestDB(t)
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if err := database.Migrate(ctx, db); err != nil {
			t.Fatal(err)
		}
	}
	requireScalar(t, db, 2, "SELECT count(*) FROM schema_migrations")
	requireScalar(t, db, 14, "SELECT count(*) FROM products")
	requireScalar(t, db, 2, "SELECT count(*) FROM sales_orders")
	requireScalar(t, db, 0, `SELECT count(*) FROM sales_orders o WHERE total <>
        (SELECT sum(qty::bigint*unit_price) FROM sales_order_items WHERE order_id=o.id)`)
	requireScalar(t, db, 0, `SELECT count(*) FROM products p WHERE stock <>
        coalesce((SELECT sum(CASE WHEN type='in' THEN qty ELSE -qty END) FROM stock_movements WHERE product_id=p.id),0)`)
}
func fixture(t *testing.T, db *pgxpool.Pool, sku string, price, stock int) int64 {
	t.Helper()
	var id int64
	err := db.QueryRow(context.Background(), "INSERT INTO products(sku,name,price,stock) VALUES($1,$1,$2,$3) RETURNING id", sku, price, stock).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
func call(h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}
func requireStatus(t *testing.T, w *httptest.ResponseRecorder, status int) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("want status %d, got %d: %s", status, w.Code, w.Body.String())
	}
}
func scalar(t *testing.T, db *pgxpool.Pool, query string, args ...interface{}) int64 {
	t.Helper()
	var n int64
	if err := db.QueryRow(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
func requireScalar(t *testing.T, db *pgxpool.Pool, want int64, query string, args ...interface{}) {
	t.Helper()
	if got := scalar(t, db, query, args...); got != want {
		t.Fatalf("%s: want %d got %d", query, want, got)
	}
}

func TestStockAdjustmentAtomicity(t *testing.T) {
	db := testDB(t)
	id := fixture(t, db, "COFFEE", 85000, 5)
	h := New(db)
	path := fmt.Sprintf("/api/products/%d/stock", id)
	w := call(h, "POST", path, `{"type":"out","qty":6,"note":"overdraw"}`)
	requireStatus(t, w, 409)
	if !strings.Contains(w.Body.String(), `"available":5`) {
		t.Fatal(w.Body.String())
	}
	requireScalar(t, db, 5, "SELECT stock FROM products WHERE id=$1", id)
	requireScalar(t, db, 0, "SELECT count(*) FROM stock_movements")
	requireStatus(t, call(h, "POST", path, `{"type":"out","qty":3,"note":"damaged"}`), 200)
	requireScalar(t, db, 2, "SELECT stock FROM products WHERE id=$1", id)
	requireScalar(t, db, 1, "SELECT count(*) FROM stock_movements WHERE product_id=$1 AND type='out' AND qty=3 AND note='damaged'", id)
	requireStatus(t, call(h, "POST", path, `{"type":"in","qty":8}`), 200)
	requireScalar(t, db, 10, "SELECT stock FROM products WHERE id=$1", id)
	requireScalar(t, db, 2, "SELECT count(*) FROM stock_movements")
}
func TestOrderInsufficientWritesNothing(t *testing.T) {
	db := testDB(t)
	fixture(t, db, "A", 100, 10)
	fixture(t, db, "B", 200, 2)
	h := New(db)
	w := call(h, "POST", "/api/orders", `{"customer":"Cafe","items":[{"sku":"A","qty":3},{"sku":"B","qty":3}]}`)
	requireStatus(t, w, 409)
	if !strings.Contains(w.Body.String(), `"sku":"B"`) || !strings.Contains(w.Body.String(), `"available":2`) {
		t.Fatal(w.Body.String())
	}
	requireScalar(t, db, 10, "SELECT stock FROM products WHERE sku='A'")
	requireScalar(t, db, 2, "SELECT stock FROM products WHERE sku='B'")
	for _, table := range []string{"sales_orders", "sales_order_items", "stock_movements"} {
		requireScalar(t, db, 0, "SELECT count(*) FROM "+table)
	}
}
func TestOrderValidationAndPriceAuthority(t *testing.T) {
	db := testDB(t)
	fixture(t, db, "A", 100, 10)
	h := New(db)
	bodies := []string{
		`{"customer":"Cafe","items":[]}`,
		`{"customer":" ","items":[{"sku":"A","qty":1}]}`,
		`{"customer":"Cafe","items":[{"sku":"A","qty":0}]}`,
		`{"customer":"Cafe","items":[{"sku":"A","qty":-1}]}`,
		`{"customer":"Cafe","items":[{"sku":"A","qty":1.5}]}`,
		`{"customer":"Cafe","items":[{"sku":"A","qty":1},{"sku":" A ","qty":1}]}`,
		`{"customer":"Cafe","items":[{"sku":"A","qty":1},{"sku":"MISSING","qty":1}]}`,
		`{"customer":"Cafe","items":[{"sku":"A","qty":1,"unit_price":1}]}`,
		`{"customer":"Cafe","items":[{"sku":"A","qty":1}],"total":1}`,
		`null`, `{} {}`, `{"customer":"Cafe","items":[{"sku":"A","qty":null}]}`,
	}
	for _, body := range bodies {
		requireStatus(t, call(h, "POST", "/api/orders", body), 400)
	}
	requireScalar(t, db, 10, "SELECT stock FROM products WHERE sku='A'")
	for _, table := range []string{"sales_orders", "sales_order_items", "stock_movements"} {
		requireScalar(t, db, 0, "SELECT count(*) FROM "+table)
	}
}
func TestOrderHappyPathCancellationAndHistory(t *testing.T) {
	db := testDB(t)
	id := fixture(t, db, "A", 100, 10)
	fixture(t, db, "B", 250, 5)
	h := New(db)
	w := call(h, "POST", "/api/orders", `{"customer":"Cafe","items":[{"sku":"A","qty":2},{"sku":"B","qty":3}]}`)
	requireStatus(t, w, 201)
	var order Order
	if err := json.Unmarshal(w.Body.Bytes(), &order); err != nil {
		t.Fatal(err)
	}
	if order.Total != 950 || len(order.Items) != 2 || order.Items[0].UnitPrice != 100 {
		t.Fatalf("wrong order: %+v", order)
	}
	requireScalar(t, db, 8, "SELECT stock FROM products WHERE sku='A'")
	requireScalar(t, db, 2, "SELECT stock FROM products WHERE sku='B'")
	requireScalar(t, db, 2, "SELECT count(*) FROM stock_movements WHERE type='out' AND order_id=$1", order.ID)
	requireStatus(t, call(h, "PUT", fmt.Sprintf("/api/products/%d", id), `{"sku":"A","name":"New name","price":999,"is_active":false}`), 200)
	w = call(h, "GET", fmt.Sprintf("/api/orders/%d", order.ID), "")
	requireStatus(t, w, 200)
	if !bytes.Contains(w.Body.Bytes(), []byte(`"unit_price":100`)) {
		t.Fatal("price snapshot changed")
	}
	requireStatus(t, call(h, "DELETE", fmt.Sprintf("/api/products/%d", id), ""), 409)
	requireStatus(t, call(h, "PUT", fmt.Sprintf("/api/products/%d", id), `{"sku":"RENAMED","name":"New name","price":100}`), 409)
	cancelPath := fmt.Sprintf("/api/orders/%d/cancel", order.ID)
	requireStatus(t, call(h, "POST", cancelPath, ""), 200)
	requireStatus(t, call(h, "POST", cancelPath, ""), 409)
	requireScalar(t, db, 10, "SELECT stock FROM products WHERE sku='A'")
	requireScalar(t, db, 5, "SELECT stock FROM products WHERE sku='B'")
	requireScalar(t, db, 4, "SELECT count(*) FROM stock_movements")
	requireScalar(t, db, 1, "SELECT count(*) FROM sales_orders WHERE status='CANCELLED' AND cancelled_at IS NOT NULL")
}
func TestConcurrentOrdersNeverOversell(t *testing.T) {
	db := testDB(t)
	fixture(t, db, "A", 100, 10)
	h := New(db)
	const attempts = 24
	results := make(chan *httptest.ResponseRecorder, attempts)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			results <- call(h, "POST", "/api/orders", `{"customer":"Concurrent cafe","items":[{"sku":"A","qty":1}]}`)
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	successes, conflicts := 0, 0
	for w := range results {
		switch w.Code {
		case 201:
			successes++
		case 409:
			conflicts++
			if !strings.Contains(w.Body.String(), "INSUFFICIENT_STOCK") {
				t.Error(w.Body.String())
			}
		default:
			t.Errorf("unexpected status %d: %s", w.Code, w.Body.String())
		}
	}
	if successes != 10 || conflicts != 14 {
		t.Fatalf("successes=%d conflicts=%d", successes, conflicts)
	}
	requireScalar(t, db, 0, "SELECT stock FROM products WHERE sku='A'")
	requireScalar(t, db, 10, "SELECT count(*) FROM sales_orders")
	requireScalar(t, db, 10, "SELECT count(*) FROM stock_movements")
}
func TestConcurrentCancellationRestoresOnlyOnce(t *testing.T) {
	db := testDB(t)
	fixture(t, db, "A", 100, 5)
	h := New(db)
	w := call(h, "POST", "/api/orders", `{"customer":"Cafe","items":[{"sku":"A","qty":3}]}`)
	requireStatus(t, w, 201)
	var order Order
	if err := json.Unmarshal(w.Body.Bytes(), &order); err != nil {
		t.Fatal(err)
	}
	const attempts = 8
	results := make(chan *httptest.ResponseRecorder, attempts)
	var wg sync.WaitGroup
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- call(h, "POST", fmt.Sprintf("/api/orders/%d/cancel", order.ID), "")
		}()
	}
	wg.Wait()
	close(results)
	successes := 0
	for w := range results {
		if w.Code == 200 {
			successes++
		} else {
			requireStatus(t, w, 409)
		}
	}
	if successes != 1 {
		t.Fatalf("%d cancellations succeeded", successes)
	}
	requireScalar(t, db, 5, "SELECT stock FROM products WHERE sku='A'")
	requireScalar(t, db, 2, "SELECT count(*) FROM stock_movements")
}
func TestOppositeItemOrderDoesNotDeadlock(t *testing.T) {
	db := testDB(t)
	fixture(t, db, "A", 100, 20)
	fixture(t, db, "B", 200, 20)
	h := New(db)
	results := make(chan *httptest.ResponseRecorder, 20)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			items := `{"sku":"A","qty":1},{"sku":"B","qty":1}`
			if i%2 == 0 {
				items = `{"sku":"B","qty":1},{"sku":"A","qty":1}`
			}
			results <- call(h, "POST", "/api/orders", `{"customer":"Cafe","items":[`+items+`]}`)
		}(i)
	}
	wg.Wait()
	close(results)
	for w := range results {
		requireStatus(t, w, 201)
	}
	requireScalar(t, db, 0, "SELECT sum(stock) FROM products")
	requireScalar(t, db, 40, "SELECT count(*) FROM stock_movements")
}
func TestMidWriteDatabaseFailureRollsBack(t *testing.T) {
	db := testDB(t)
	fixture(t, db, "A", 100, 10)
	fixture(t, db, "B", 200, 10)
	h := New(db)
	// Force a real SQL error on the second movement, after earlier writes. This
	// proves rollback rather than merely checking prevalidation paths.
	_, err := db.Exec(context.Background(), `CREATE FUNCTION reject_b() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.product_id = (SELECT id FROM products WHERE sku='B') THEN RAISE EXCEPTION 'forced failure'; END IF;
        RETURN NEW; END $$;
        CREATE TRIGGER reject_b BEFORE INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION reject_b();`)
	if err != nil {
		t.Fatal(err)
	}
	requireStatus(t, call(h, "POST", "/api/orders", `{"customer":"Cafe","items":[{"sku":"A","qty":1},{"sku":"B","qty":1}]}`), 500)
	requireScalar(t, db, 20, "SELECT sum(stock) FROM products")
	for _, table := range []string{"sales_orders", "sales_order_items", "stock_movements"} {
		requireScalar(t, db, 0, "SELECT count(*) FROM "+table)
	}
}
func TestProductsSearchPaginationAndSummary(t *testing.T) {
	db := testDB(t)
	h := New(db)
	for _, body := range []string{`{"sku":"A","name":"Coffee","price":85000}`, `{"sku":"B","name":"Tea","price":25000,"is_active":false}`} {
		requireStatus(t, call(h, "POST", "/api/products", body), 201)
	}
	requireStatus(t, call(h, "POST", "/api/products", `{"sku":"A","name":"Duplicate","price":0}`), 409)
	for _, body := range []string{`{"sku":"Z","name":"Test"}`, `{"sku":"Z","name":"Test","price":-1}`, `{"sku":"Z","name":"Test","price":1.5}`, `{"sku":"Z","name":"Test","price":null}`, `{"sku":"Z","name":"Test","price":2147483648}`, `{"sku":"Z","name":"Test","price":0,"stock":10}`} {
		requireStatus(t, call(h, "POST", "/api/products", body), 400)
	}
	w := call(h, "GET", "/api/products?search=cOfFeE&page=1&limit=1", "")
	requireStatus(t, w, 200)
	if !strings.Contains(w.Body.String(), `"total":1`) || !strings.Contains(w.Body.String(), `"last_movement_at":null`) {
		t.Fatal(w.Body.String())
	}
	requireStatus(t, call(h, "GET", "/api/products?page=0", ""), 400)
	requireStatus(t, call(h, "GET", "/api/products?limit=101", ""), 400)
	w = call(h, "GET", "/api/products?filter=inactive", "")
	requireStatus(t, w, 200)
	if !strings.Contains(w.Body.String(), `"sku":"B"`) || !strings.Contains(w.Body.String(), `"total":1`) {
		t.Fatal(w.Body.String())
	}
	requireStatus(t, call(h, "POST", "/api/products/1/stock", `{"type":"in","qty":12}`), 200)
	w = call(h, "GET", "/api/summary", "")
	requireStatus(t, w, 200)
	if !strings.Contains(w.Body.String(), `"total_stock_value":"1020000"`) || !strings.Contains(w.Body.String(), `"low_stock_count":1`) {
		t.Fatal(w.Body.String())
	}
	requireStatus(t, call(h, "DELETE", "/api/products/2", ""), 204)
	requireStatus(t, call(h, "DELETE", "/api/products/2", ""), 404)
	requireStatus(t, call(h, "PUT", "/api/products/99", `{"sku":"Z","name":"Test","price":0}`), 404)
}
func TestOverflowDoesNotWrite(t *testing.T) {
	db := testDB(t)
	id := fixture(t, db, "A", 2147483647, 2147483647)
	h := New(db)
	requireStatus(t, call(h, "POST", fmt.Sprintf("/api/products/%d/stock", id), `{"type":"in","qty":1}`), 409)
	requireStatus(t, call(h, "POST", "/api/orders", `{"customer":"Cafe","items":[{"sku":"A","qty":2}]}`), 400)
	requireScalar(t, db, 0, "SELECT count(*) FROM stock_movements")
	requireScalar(t, db, maxInteger, "SELECT stock FROM products WHERE sku='A'")
}

func TestStatusChangePreservesLatestProductAndHistory(t *testing.T) {
	db := testDB(t)
	id := fixture(t, db, "A", 100, 0)
	h := New(db)
	path := fmt.Sprintf("/api/products/%d", id)
	requireStatus(t, call(h, "POST", path+"/stock", `{"type":"in","qty":5}`), 200)
	// Another editor changes catalog fields while the deactivation dialog is open.
	requireStatus(t, call(h, "PUT", path, `{"sku":"A","name":"Updated by another editor","price":250}`), 200)
	w := call(h, "PATCH", path+"/status", `{"is_active":false}`)
	requireStatus(t, w, 200)
	var p Product
	if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	if p.IsActive || p.Name != "Updated by another editor" || p.Price != 250 || p.Stock != 5 || p.LastMovementAt == nil {
		t.Fatalf("status change damaged product data: %+v", p)
	}
	requireScalar(t, db, 1, "SELECT count(*) FROM stock_movements WHERE product_id=$1", id)
	requireStatus(t, call(h, "POST", "/api/orders", `{"customer":"Cafe","items":[{"sku":"A","qty":1}]}`), 400)
	for _, body := range []string{`{}`, `null`, `{"is_active":null}`, `{"is_active":"false"}`, `{"is_active":false,"price":1}`} {
		requireStatus(t, call(h, "PATCH", path+"/status", body), 400)
	}
	requireStatus(t, call(h, "PATCH", "/api/products/999/status", `{"is_active":true}`), 404)
	requireStatus(t, call(h, "PATCH", path+"/status", `{"is_active":true}`), 200)
	requireStatus(t, call(h, "POST", "/api/orders", `{"customer":"Cafe","items":[{"sku":"A","qty":1}]}`), 201)
}

func TestCancellationStockLimitIsAtomic(t *testing.T) {
	db := testDB(t)
	fixture(t, db, "A", 100, 5)
	b := fixture(t, db, "B", 200, 5)
	h := New(db)
	w := call(h, "POST", "/api/orders", `{"customer":"Cafe","items":[{"sku":"A","qty":2},{"sku":"B","qty":2}]}`)
	requireStatus(t, w, 201)
	var order Order
	if err := json.Unmarshal(w.Body.Bytes(), &order); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, call(h, "POST", fmt.Sprintf("/api/products/%d/stock", b), `{"type":"in","qty":2147483644}`), 200)
	w = call(h, "POST", fmt.Sprintf("/api/orders/%d/cancel", order.ID), "")
	requireStatus(t, w, 409)
	if !strings.Contains(w.Body.String(), "STOCK_LIMIT") {
		t.Fatal(w.Body.String())
	}
	requireScalar(t, db, 3, "SELECT stock FROM products WHERE sku='A'")
	requireScalar(t, db, maxInteger, "SELECT stock FROM products WHERE sku='B'")
	requireScalar(t, db, 3, "SELECT count(*) FROM stock_movements")
	requireScalar(t, db, 1, "SELECT count(*) FROM sales_orders WHERE status='CREATED' AND cancelled_at IS NULL")
}
func TestValidateOrder(t *testing.T) {
	cases := []struct {
		name  string
		input orderInput
		valid bool
	}{
		{"valid", orderInput{" Cafe ", []itemInput{{"A", 2}}}, true},
		{"empty", orderInput{"Cafe", nil}, false},
		{"zero", orderInput{"Cafe", []itemInput{{"A", 0}}}, false},
		{"duplicate", orderInput{"Cafe", []itemInput{{"A", 1}, {" A ", 2}}}, false},
		{"customer", orderInput{" ", []itemInput{{"A", 1}}}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := validateOrder(&c.input)
			if (err == nil) != c.valid {
				t.Fatalf("unexpected validation: %v", err)
			}
		})
	}
}
