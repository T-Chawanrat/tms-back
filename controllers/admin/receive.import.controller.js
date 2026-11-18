// server/controllers/admin/receive.import.controller.js

import db from "../../config/db.js";
import { buildInsertSql } from "../../utils/sql.js";
import { toNumberOrNull } from "../../utils/input.js";
import {
  readExcelRows,
  normalizeImportRow,
  isEmptyImportRow,
  groupRowsByNoBill,
  validateImportHeadRow,
  validateSameBillHeader,
  buildReceiveCodeMapByNoBill,
  getMasterAddressBySubdistrictId,
  getShipperByCustomerAndCode,
  getRequestUserId,
  createImportLog,
  updateImportLogRunning,
  updateImportLogSuccess,
  updateImportLogFailed,
  buildImportHeadData,
  buildImportDetailData,
  buildImportDetailItemData,
  makeAutoImportSerial,
  createActiveSerialOrThrow,
  getPackageByCode,
  insertImportReceiveReference,
  insertImportReceiveSerials,
  insertImportProductTransactions,
} from "../../services/receive-import.js";
import { insertReceiveCreationLog } from "../../services/receive-creation-log.js";
import { getPickupAssignment } from "../../services/receive.js";

const getDeletedPickupRoute = async (conn, pickupSource, sourceId) => {
  const sources = {
    CUSTOMER: {
      sql: `
        SELECT route.route_code, route.route_name
        FROM mm_customers customer
        INNER JOIN mm_route_details route_detail
          ON route_detail.subdistrict_id = customer.subdistrict_id
        INNER JOIN mm_routes route
          ON route.route_id = route_detail.route_id
        WHERE customer.id = ?
          AND route.is_deleted = 'Y'
        ORDER BY route.route_code, route.route_name
        LIMIT 1
      `,
    },
    SHIPPER: {
      sql: `
        SELECT route.route_code, route.route_name
        FROM mm_shippers shipper
        INNER JOIN mm_route_details route_detail
          ON route_detail.subdistrict_id = shipper.subdistrict_id
        INNER JOIN mm_routes route
          ON route.route_id = route_detail.route_id
        WHERE shipper.shipper_id = ?
          AND route.is_deleted = 'Y'
        ORDER BY route.route_code, route.route_name
        LIMIT 1
      `,
    },
  };

  const source = sources[pickupSource];
  if (!source) return null;

  const [rows] = await conn.query(source.sql, [sourceId]);
  return rows[0] || null;
};

export const importReceivesFromExcel = async (req, res) => {
  const conn = await db.getConnection();

  let transactionStarted = false;
  let importId = null;
  let queueTotal = 0;
  let queueProcessed = 0;

  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "กรุณาอัปโหลดไฟล์ Excel",
      });
    }

    const customerId = toNumberOrNull(req.body.customer_id);
    const assignedWarehouseId = toNumberOrNull(req.body.assigned_warehouse_id);

    if (!customerId) {
      return res.status(400).json({
        success: false,
        message: "กรุณาเลือก Customer ก่อนนำเข้า",
      });
    }

    const userId = getRequestUserId(req);

    importId = await createImportLog({
      conn,
      customerId,
      createdBy: userId,
    });

    const excelRows = readExcelRows(req.file.buffer);

    const rows = excelRows.map((row, index) => normalizeImportRow(row, index, true)).filter((row) => !isEmptyImportRow(row));

    if (rows.length === 0) {
      const error = new Error("ไม่พบข้อมูลในไฟล์ Excel");
      error.statusCode = 400;
      throw error;
    }

    for (const row of rows) {
      const error = validateImportHeadRow(row);

      if (error) {
        const validateError = new Error(error);
        validateError.statusCode = 400;
        throw validateError;
      }
    }

    if (!assignedWarehouseId && rows.some((row) => row.pickup === "N")) {
      throw Object.assign(new Error("กรุณาเลือกคลังดูแลงานก่อนนำเข้า"), { statusCode: 400 });
    }

    const groupedRows = groupRowsByNoBill(rows);
    const billGroups = Array.from(groupedRows.entries());

    queueTotal = billGroups.length;

    await updateImportLogRunning({
      conn,
      importId,
      queueTotal,
      updatedBy: userId,
    });

    await conn.beginTransaction();
    transactionStarted = true;

    const addressCache = new Map();
    const shipperCache = new Map();
    const packageCache = new Map();
    const pickupCache = new Map();

    const receiveCodeByNoBill = await buildReceiveCodeMapByNoBill({
      conn,
      customerId,
      billGroups,
    });

    const importDate = new Date();
    const now = new Date();

    for (const [noBill, billRows] of billGroups) {
      validateSameBillHeader(billRows);

      const firstRow = billRows[0];

      const recipientAddress = await getMasterAddressBySubdistrictId(conn, firstRow.subdistrict_id, addressCache);

      const shipper = await getShipperByCustomerAndCode({
        conn,
        customerId,
        shipperCode: firstRow.shipper_code,
        cache: shipperCache,
      });

      const shipperAddress = await getMasterAddressBySubdistrictId(conn, shipper.subdistrict_id, addressCache);

      const pickupSource = firstRow.pickup === "N" ? null : firstRow.pickup;
      const pickupId = pickupSource === "CUSTOMER" ? customerId : shipper.shipper_id;
      const pickupKey = `${pickupSource}:${pickupId}`;
      if (pickupSource && !pickupCache.has(pickupKey)) {
        pickupCache.set(pickupKey, await getPickupAssignment(conn, pickupSource, pickupId));
      }
      const pickupAssignment = pickupSource ? pickupCache.get(pickupKey) : null;

      if (pickupSource && !pickupAssignment?.pickup_route_id) {
        const pickupName = pickupSource === "CUSTOMER" ? "เจ้าของงาน" : "ผู้ส่ง";
        const deletedRoute = await getDeletedPickupRoute(conn, pickupSource, pickupId);
        const deletedRouteLabel = [deletedRoute?.route_code, deletedRoute?.route_name].filter(Boolean).join(" - ");
        const message = deletedRouteLabel
          ? `แถว ${firstRow.row_no}: สายรถเข้ารับ ${deletedRouteLabel} ของ${pickupName}ถูกปิดใช้งาน กรุณาเปิดใช้งานหรือกำหนดสายรถใหม่ก่อนนำเข้า`
          : `แถว ${firstRow.row_no}: ยังไม่ได้กำหนดสายรถเข้ารับให้${pickupName} กรุณากำหนดสายรถก่อนนำเข้า`;

        throw Object.assign(
          new Error(message),
          { statusCode: 400 },
        );
      }

      const receiveCode = receiveCodeByNoBill.get(noBill);

      if (!receiveCode) {
        const error = new Error(`NO_BILL ${noBill}: ไม่สามารถสร้าง receive_code ได้`);
        error.statusCode = 400;
        throw error;
      }

      const data = buildImportHeadData({
        row: firstRow,
        customerId,
        shipper,
        receiveCode,
        recipientAddress,
        shipperAddress,
        importDate,
        importId,
        now,
        enablePickup: true,
      });

      const { sql, values } = buildInsertSql("tm_receive_import_head", data);

      const [headResult] = await conn.query(sql, values);

      const receiveId = headResult.insertId;

      await insertImportReceiveReference({
        conn,
        referenceNo: firstRow.reference_no,
        receiveId,
      });

      let autoSerialRunning = 1;

      for (const row of billRows) {
        const packageData = await getPackageByCode({
          conn,
          customerId,
          packageCode: row.package_code,
          q: row.q,
          weight: row.weight,
          useDifferentWarehousePrice: data.from_warehouse_id !== data.to_warehouse_id,
          cache: packageCache,
        });

        const detailData = buildImportDetailData({
          receiveId,
          row,
          packageData,
        });

        const { sql: detailSql, values: detailValues } = buildInsertSql("tm_receive_import_details", detailData);

        const [detailResult] = await conn.query(detailSql, detailValues);

        const receiveDetailId = detailResult.insertId;

        const serialNo =
          row.is_serial_no === "N"
            ? makeAutoImportSerial(receiveCode, autoSerialRunning++)
            : row.serial_no;

        const productSerial = serialNo ? await createActiveSerialOrThrow(conn, serialNo, now) : null;

        const itemData = buildImportDetailItemData({
          receiveDetailId,
          productSerial,
        });

        if (itemData) {
          const { sql: itemSql, values: itemValues } = buildInsertSql("tm_receive_import_detail_items", itemData);

          await conn.query(itemSql, itemValues);
        }
      }

      await insertImportReceiveSerials(conn, receiveId, now, pickupAssignment?.warehouse_id ?? assignedWarehouseId, pickupSource ? "tm_product_shippers" : "tm_product_customers", pickupAssignment?.pickup_route_id);

      await insertImportProductTransactions({
        conn,
        receiveId,
        createdBy: userId,
        now,
      });

      await insertReceiveCreationLog({
        conn,
        receiveId,
        receiveCode,
        customerId,
        sourceType: "IMPORT",
        sourceImportId: importId,
        detailCount: billRows.length,
        itemCount: billRows.filter((row) => row.is_serial_no === "N" || row.serial_no).length,
        createdBy: userId,
        now,
      });

      queueProcessed += 1;
    }

    await conn.commit();
    transactionStarted = false;

    await updateImportLogSuccess({
      conn,
      importId,
      queueTotal,
      queueProcessed,
      updatedBy: userId,
    });

    return res.status(201).json({
      success: true,
      message: "Import receive head สำเร็จ",
      import_id: importId,
      total_rows: rows.length,
      total_bills: billGroups.length,
      inserted_rows: queueProcessed,
    });
  } catch (error) {
    if (transactionStarted) {
      await conn.rollback();
    }

    console.error("IMPORT RECEIVES FROM EXCEL ERROR:", error);

    const statusCode = error.statusCode || 500;
    const errorMessage = error.message || "Import receive head ไม่สำเร็จ";

    await updateImportLogFailed({
      conn,
      importId,
      queueTotal,
      queueProcessed,
      errorMessage,
      updatedBy: getRequestUserId(req),
    });

    return res.status(statusCode).json({
      success: false,
      message: statusCode === 400 ? errorMessage : "Import receive head ไม่สำเร็จ",
      error: errorMessage,
      import_id: importId,
    });
  } finally {
    conn.release();
  }
};

export const validateReceiveImportRows = async (req, res) => {
  const conn = await db.getConnection();

  try {
    const customerId = toNumberOrNull(req.body.customer_id);
    const inputRows = req.body.rows;

    if (!customerId) {
      return res.status(400).json({
        success: false,
        message: "กรุณาเลือก Customer ก่อนตรวจสอบข้อมูล",
      });
    }

    if (!Array.isArray(inputRows) || inputRows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "ไม่พบข้อมูลสำหรับตรวจสอบ",
      });
    }

    const rows = inputRows.map((row, index) => normalizeImportRow(row, index)).filter((row) => !isEmptyImportRow(row));

    const invalidRows = {};

    const addressCache = new Map();
    const shipperCache = new Map();

    const addError = (index, field, message) => {
      if (!invalidRows[index]) {
        invalidRows[index] = {};
      }

      invalidRows[index][field] = message;
    };

    const normalizeCompare = (value) => {
      return String(value || "").trim();
    };

    const pickAddressValue = (address, keys) => {
      for (const key of keys) {
        if (address?.[key] !== undefined && address?.[key] !== null) {
          return address[key];
        }
      }

      return "";
    };

    for (const row of rows) {
      const index = row.row_index ?? row.__row_index ?? row.index ?? 0;

      const subdistrictId = toNumberOrNull(row.subdistrict_id);
      const shipperCode = String(row.shipper_code || "").trim();

      if (!subdistrictId) {
        addError(index, "subdistrict_id", "ไม่มี subdistrict_id");
      } else {
        try {
          const recipientAddress = await getMasterAddressBySubdistrictId(conn, subdistrictId, addressCache);

          const masterSubdistrict = normalizeCompare(
            pickAddressValue(recipientAddress, ["subdistrict_name", "subdistrict", "SUBDISTRICT_NAME", "SUBDISTRICT", "name_th"]),
          );

          const masterDistrict = normalizeCompare(
            pickAddressValue(recipientAddress, ["district_name", "district", "DISTRICT_NAME", "DISTRICT", "amphur_name"]),
          );

          const masterProvince = normalizeCompare(pickAddressValue(recipientAddress, ["province_name", "province", "PROVINCE_NAME", "PROVINCE"]));

          const masterZipcode = normalizeCompare(pickAddressValue(recipientAddress, ["zipcode", "zip_code", "ZIPCODE", "ZIP_CODE", "postcode"]));

          const excelSubdistrict = normalizeCompare(row.recipient_subdistrict);
          const excelDistrict = normalizeCompare(row.recipient_district);
          const excelProvince = normalizeCompare(row.recipient_province);
          const excelZipcode = normalizeCompare(row.recipient_zipcode);

          const canCompareAddress = masterSubdistrict || masterDistrict || masterProvince || masterZipcode;

          const isAddressNotMatch =
            canCompareAddress &&
            (excelSubdistrict !== masterSubdistrict ||
              excelDistrict !== masterDistrict ||
              excelProvince !== masterProvince ||
              excelZipcode !== masterZipcode);

          if (isAddressNotMatch) {
            addError(index, "address", "ที่อยู่ไม่ตรงกับ subdistrict_id ในฐานข้อมูล");
          }
        } catch (error) {
          addError(index, "subdistrict_id", error.message || "ไม่พบ subdistrict_id ในระบบ");
        }
      }

      if (!shipperCode) {
        addError(index, "SHIPPER_CODE", "ไม่มี SHIPPER_CODE");
      } else {
        try {
          await getShipperByCustomerAndCode({
            conn,
            customerId,
            shipperCode,
            cache: shipperCache,
          });
        } catch (error) {
          addError(index, "SHIPPER_CODE", error.message || "ไม่พบ SHIPPER_CODE ของ Customer นี้");
        }
      }
    }

    return res.json({
      success: true,
      invalidRows,
    });
  } catch (error) {
    console.error("VALIDATE RECEIVE IMPORT ROWS ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "ตรวจสอบข้อมูลกับฐานข้อมูลไม่สำเร็จ",
      error: error.message,
    });
  } finally {
    conn.release();
  }
};
