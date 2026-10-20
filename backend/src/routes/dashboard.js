import { Router } from 'express';
import { query } from '../db.js';

const r = Router();

r.get('/summary', async (req, res) => {
  const [stock, byStatus, aging, monthSales, salesTrend, leads, byLot, topModels, expiring, overpriced, partners] = await Promise.all([
    query(`
      SELECT count(*) AS units,
             coalesce(sum(total_cost), 0) AS inventory_cost,
             coalesce(sum(list_price), 0) AS inventory_list_value,
             round(avg(days_in_stock)) AS avg_days_in_stock,
             count(*) FILTER (WHERE status = 'available') AS available
      FROM v_inventory WHERE is_in_stock AND is_own`),
    query(`
      SELECT s.code AS status, s.label, count(v.id) AS units
      FROM vehicle_statuses s LEFT JOIN vehicles v ON v.status = s.code AND v.owner_partner_id IS NULL
      GROUP BY s.code, s.label, s.sort_order ORDER BY s.sort_order`),
    query(`
      SELECT b.bucket, coalesce(a.units, 0) AS units, coalesce(a.total_cost, 0) AS total_cost
      FROM (VALUES ('0-30', 1), ('31-60', 2), ('61-90', 3), ('90+', 4)) AS b(bucket, ord)
      LEFT JOIN v_inventory_aging a ON a.bucket = b.bucket ORDER BY b.ord`),
    // Ventas que nos generan ingreso: las propias, las de socios sobre nuestro inventario
    // y nuestras ventas de vehículos de socios (cuenta sólo la comisión). Las ventas que un
    // socio hace de su propio inventario sólo se reflejan y no cuentan.
    query(`
      SELECT count(*) AS units,
             coalesce(sum(sale_price - discount_amount) FILTER (WHERE sale_type IN ('direct','partner_sold_ours')), 0) AS revenue,
             coalesce(sum(gross_profit), 0) AS gross_profit,
             count(*) FILTER (WHERE sale_type <> 'direct') AS via_partners
      FROM sales
      WHERE status <> 'cancelled' AND sale_type <> 'partner_own' AND sale_date >= date_trunc('month', current_date)`),
    query(`
      SELECT to_char(m, 'YYYY-MM') AS month,
             count(s.id) AS units,
             coalesce(sum(s.sale_price - s.discount_amount) FILTER (WHERE s.sale_type IN ('direct','partner_sold_ours')), 0) AS revenue,
             coalesce(sum(s.gross_profit), 0) AS gross_profit
      FROM generate_series(date_trunc('month', current_date) - interval '5 months',
                           date_trunc('month', current_date), interval '1 month') m
      LEFT JOIN sales s ON s.status <> 'cancelled' AND s.sale_type <> 'partner_own'
                       AND date_trunc('month', s.sale_date) = m
      GROUP BY m ORDER BY m`),
    query(`
      SELECT st AS status, count(l.id) AS leads
      FROM unnest(ARRAY['new','contacted','qualified','test_drive','negotiation','won','lost']) WITH ORDINALITY AS t(st, ord)
      LEFT JOIN leads l ON l.status = t.st
      GROUP BY st, ord ORDER BY ord`),
    query(`
      SELECT l.id, l.code, l.name, l.capacity, count(v.id) FILTER (WHERE v.is_in_stock) AS units
      FROM lots l LEFT JOIN v_inventory v ON v.lot_id = l.id
      WHERE l.is_active GROUP BY l.id ORDER BY l.code`),
    query(`
      SELECT make, model, count(*) AS units, round(avg(days_in_stock)) AS avg_days
      FROM v_inventory WHERE is_in_stock AND is_own GROUP BY make, model ORDER BY units DESC, make LIMIT 8`),
    query(`
      SELECT r.id, r.expires_at, v.id AS vehicle_id, v.stock_number,
             concat_ws(' ', mk.name, md.name, v.year) AS vehicle_label,
             concat_ws(' ', c.first_name, c.last_name, c.company_name) AS contact_name
      FROM reservations r
      JOIN vehicles v ON v.id = r.vehicle_id
      JOIN makes mk ON mk.id = v.make_id JOIN models md ON md.id = v.model_id
      JOIN contacts c ON c.id = r.contact_id
      WHERE r.status = 'active' ORDER BY r.expires_at LIMIT 10`),
    // Unidades propias con precio > 8% arriba del mercado, o más de 90 días en piso
    query(`
      SELECT id, stock_number, make, model, year, list_price, market_value, days_in_stock,
             round((list_price / nullif(market_value, 0) - 1) * 100, 1) AS pct_vs_market
      FROM v_inventory
      WHERE is_own AND status = 'available' AND (list_price > market_value * 1.08 OR days_in_stock > 90)
      ORDER BY days_in_stock DESC LIMIT 10`),
    query(`
      SELECT
        (SELECT count(*) FROM partners WHERE is_active) AS active_partners,
        (SELECT count(*) FROM vehicles v JOIN vehicle_statuses s ON s.code = v.status
          WHERE v.owner_partner_id IS NOT NULL AND v.status = 'available') AS partner_vehicles_available,
        (SELECT count(*) FROM vehicles WHERE owner_partner_id IS NULL AND syndicate AND status = 'available') AS shared_vehicles,
        (SELECT coalesce(sum(commission_amount), 0) FROM sales WHERE sale_type = 'partner_sold_ours' AND status <> 'cancelled'
          AND sale_date >= date_trunc('month', current_date)) AS commissions_payable,
        (SELECT coalesce(sum(commission_amount), 0) FROM sales WHERE sale_type = 'we_sold_partner' AND status <> 'cancelled'
          AND sale_date >= date_trunc('month', current_date)) AS commissions_receivable`),
  ]);

  res.json({
    stock: stock.rows[0],
    by_status: byStatus.rows,
    aging: aging.rows,
    month_sales: monthSales.rows[0],
    sales_trend: salesTrend.rows,
    leads_funnel: leads.rows,
    by_lot: byLot.rows,
    top_models: topModels.rows,
    reservations: expiring.rows,
    attention: overpriced.rows,
    partners: partners.rows[0],
  });
});

export default r;
