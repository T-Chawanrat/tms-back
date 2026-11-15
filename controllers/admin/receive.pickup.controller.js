import db from "../../config/db.js";
import { getPositiveInteger } from "../../utils/pagination.js";

const buildPickupBillsSql = () => `
  SELECT
    'WEB' AS source_type,
    r.receive_id,
    r.receive_code,
    r.receive_date,
    r.delivery_date,
    r.customer_id,
    r.shipper_id,
    r.to_warehouse_id,
    r.is_pickup_customer,
    r.is_pickup_shipper
  FROM tm_receives r
  WHERE r.is_pickup_customer = 'Y'
     OR r.is_pickup_shipper = 'Y'

  UNION ALL

  SELECT
    'IMPORT' AS source_type,
    h.receive_id,
    h.receive_code,
    h.receive_date,
    h.delivery_date,
    h.customer_id,
    h.shipper_id,
    h.to_warehouse_id,
    h.is_pickup_customer,
    h.is_pickup_shipper
  FROM tm_receive_import_head h
  WHERE h.is_pickup_customer = 'Y'
     OR h.is_pickup_shipper = 'Y'
`;

export const getPickupReceives = async (req, res) => {
  try {
    const page = getPositiveInteger(req.query.page, 1, Number.MAX_SAFE_INTEGER);
    const limit = getPositiveInteger(req.query.limit, 50, 100);
    const offset = (page - 1) * limit;
    const pickupBillsSql = buildPickupBillsSql();

    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total FROM (${pickupBillsSql}) pickup_bills`,
    );

    const [rows] = await db.query(
      `
        SELECT
          bill.source_type,
          bill.receive_id,
          bill.receive_code,
          bill.receive_date,
          bill.delivery_date,
          bill.customer_id,
          customer.code AS customer_code,
          customer.name AS customer_name,
          bill.shipper_id,
          shipper.shipper_code,
          shipper.shipper_name,
          shipper.address AS shipper_address,
          shipper.tel AS shipper_tel,
          bill.to_warehouse_id,
          destination_warehouse.warehouse_name AS to_warehouse_name,

          CASE
            WHEN bill.is_pickup_customer = 'Y' THEN 'CUSTOMER'
            WHEN bill.is_pickup_shipper = 'Y' THEN 'SHIPPER'
            ELSE NULL
          END AS pickup_type,

          CASE
            WHEN bill.is_pickup_customer = 'Y' THEN customer.name
            WHEN bill.is_pickup_shipper = 'Y' THEN shipper.shipper_name
            ELSE NULL
          END AS pickup_name,

          CASE
            WHEN bill.is_pickup_customer = 'Y' THEN customer_address.subdistrict_id
            WHEN bill.is_pickup_shipper = 'Y' THEN shipper_address.subdistrict_id
            ELSE NULL
          END AS pickup_subdistrict_id,

          CASE
            WHEN bill.is_pickup_customer = 'Y' THEN customer_address.subdistrict_name
            WHEN bill.is_pickup_shipper = 'Y' THEN shipper_address.subdistrict_name
            ELSE NULL
          END AS pickup_subdistrict_name,

          CASE
            WHEN bill.is_pickup_customer = 'Y' THEN customer_address.district_name
            WHEN bill.is_pickup_shipper = 'Y' THEN shipper_address.district_name
            ELSE NULL
          END AS pickup_district_name,

          CASE
            WHEN bill.is_pickup_customer = 'Y' THEN customer_address.province_name
            WHEN bill.is_pickup_shipper = 'Y' THEN shipper_address.province_name
            ELSE NULL
          END AS pickup_province_name,

          CASE
            WHEN bill.is_pickup_customer = 'Y' THEN customer_address.warehouse_id
            WHEN bill.is_pickup_shipper = 'Y' THEN shipper_address.warehouse_id
            ELSE NULL
          END AS assigned_warehouse_id,

          CASE
            WHEN bill.is_pickup_customer = 'Y' THEN customer_warehouse.warehouse_name
            WHEN bill.is_pickup_shipper = 'Y' THEN shipper_warehouse.warehouse_name
            ELSE NULL
          END AS assigned_warehouse_name,

          COALESCE(serials.total_serial, 0) AS total_serial
        FROM (${pickupBillsSql}) bill
        LEFT JOIN mm_customers customer
          ON customer.id = bill.customer_id
        LEFT JOIN mm_shippers shipper
          ON shipper.shipper_id = bill.shipper_id
        LEFT JOIN mm_master_addresses customer_address
          ON customer_address.subdistrict_id = customer.subdistrict_id
          AND customer_address.district_id = customer.district_id
          AND customer_address.province_id = customer.province_id
        LEFT JOIN mm_master_addresses shipper_address
          ON shipper_address.subdistrict_id = shipper.subdistrict_id
          AND shipper_address.district_id = shipper.district_id
          AND shipper_address.province_id = shipper.province_id
        LEFT JOIN mm_warehouses_to customer_warehouse
          ON customer_warehouse.warehouse_id = customer_address.warehouse_id
        LEFT JOIN mm_warehouses_to shipper_warehouse
          ON shipper_warehouse.warehouse_id = shipper_address.warehouse_id
        LEFT JOIN mm_warehouses_to destination_warehouse
          ON destination_warehouse.warehouse_id = bill.to_warehouse_id
        LEFT JOIN (
          SELECT
            source_type,
            receive_business_id,
            COUNT(DISTINCT serial_no) AS total_serial
          FROM tm_receive_serials
          WHERE serial_no IS NOT NULL
            AND TRIM(serial_no) <> ''
            AND COALESCE(item_is_deleted, 'N') = 'N'
          GROUP BY source_type, receive_business_id
        ) serials
          ON serials.source_type = bill.source_type
          AND serials.receive_business_id = bill.receive_id
        ORDER BY bill.receive_date DESC, bill.receive_code DESC
        LIMIT ? OFFSET ?
      `,
      [limit, offset],
    );

    const total = Number(countRows[0]?.total || 0);

    return res.json({
      success: true,
      data: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("getPickupReceives error:", error);
    return res.status(500).json({
      success: false,
      message: "ไม่สามารถโหลดรายการรถเข้ารับพัสดุได้",
    });
  }
};

export const getPickupReceiveSerials = async (req, res) => {
  try {
    const receiveId = Number(req.params.receiveId);
    const sourceType = String(req.params.sourceType || "").trim().toUpperCase();

    if (!Number.isInteger(receiveId) || receiveId <= 0) {
      return res.status(400).json({ success: false, message: "receive_id ไม่ถูกต้อง" });
    }

    if (!["WEB", "IMPORT"].includes(sourceType)) {
      return res.status(400).json({ success: false, message: "source_type ไม่ถูกต้อง" });
    }

    const [rows] = await db.query(
      `
        SELECT
          serial_id,
          serial_no,
          package_id,
          package_name,
          package_detail_id,
          package_detail_name,
          weight,
          width,
          length,
          height,
          q
        FROM tm_receive_serials
        WHERE receive_business_id = ?
          AND source_type = ?
          AND serial_no IS NOT NULL
          AND TRIM(serial_no) <> ''
          AND COALESCE(item_is_deleted, 'N') = 'N'
        ORDER BY serial_no ASC
      `,
      [receiveId, sourceType],
    );

    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error("getPickupReceiveSerials error:", error);
    return res.status(500).json({
      success: false,
      message: "ไม่สามารถโหลดรายการ SN ของบิลได้",
    });
  }
};
