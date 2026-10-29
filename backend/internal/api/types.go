package api

import "time"

const maxInteger int64 = 2147483647

type Product struct {
	ID             int64      `json:"id"`
	SKU            string     `json:"sku"`
	Name           string     `json:"name"`
	Price          int64      `json:"price"`
	Stock          int64      `json:"stock"`
	IsActive       bool       `json:"is_active"`
	CreatedAt      time.Time  `json:"created_at"`
	LastMovementAt *time.Time `json:"last_movement_at"`
}
type Movement struct {
	ID        int64     `json:"id"`
	ProductID int64     `json:"product_id"`
	Type      string    `json:"type"`
	Qty       int64     `json:"qty"`
	Note      string    `json:"note"`
	OrderID   *int64    `json:"order_id"`
	CreatedAt time.Time `json:"created_at"`
}
type OrderItem struct {
	SKU       string `json:"sku"`
	Qty       int64  `json:"qty"`
	UnitPrice int64  `json:"unit_price"`
}
type Order struct {
	ID          int64       `json:"id"`
	Customer    string      `json:"customer"`
	Status      string      `json:"status"`
	Total       int64       `json:"total"`
	CreatedAt   time.Time   `json:"created_at"`
	CancelledAt *time.Time  `json:"cancelled_at"`
	Items       []OrderItem `json:"items"`
}
type productInput struct {
	SKU      string `json:"sku"`
	Name     string `json:"name"`
	Price    *int64 `json:"price"`
	IsActive *bool  `json:"is_active"`
}
type stockInput struct {
	Type string `json:"type"`
	Qty  int64  `json:"qty"`
	Note string `json:"note"`
}
type itemInput struct {
	SKU string `json:"sku"`
	Qty int64  `json:"qty"`
}
type orderInput struct {
	Customer string      `json:"customer"`
	Items    []itemInput `json:"items"`
}
type apiError struct {
	Status    int               `json:"-"`
	Code      string            `json:"code"`
	Message   string            `json:"message"`
	SKU       string            `json:"sku,omitempty"`
	Available *int64            `json:"available,omitempty"`
	Fields    map[string]string `json:"fields,omitempty"`
}

func (e *apiError) Error() string { return e.Message }
func problem(status int, code, message string) *apiError {
	return &apiError{Status: status, Code: code, Message: message}
}
func invalid(message string) *apiError { return problem(400, "VALIDATION_ERROR", message) }
func insufficient(sku string, stock int64) *apiError {
	return &apiError{Status: 409, Code: "INSUFFICIENT_STOCK", Message: "Insufficient stock for " + sku, SKU: sku, Available: &stock}
}
