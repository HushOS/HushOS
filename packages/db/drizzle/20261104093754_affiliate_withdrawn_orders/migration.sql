-- Hand-edited (this header). Orders HushOS refunded whole, kept so a late `order.paid` delivery
-- never records commission on one after it was taken back. A new table: no lock on any existing
-- one, and an old web container never reads or writes it.
CREATE TABLE "affiliate_withdrawn_orders" (
	"order_id" text PRIMARY KEY,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
