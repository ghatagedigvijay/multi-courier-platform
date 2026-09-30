import { z } from 'zod';

const addressSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(7).max(20),
  address_line1: z.string().trim().min(1).max(250),
  address_line2: z.string().trim().max(250).optional(),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().min(1).max(100),
  postal_code: z.string().trim().min(3).max(20),
  country: z.string().trim().length(2).default('IN'),
});

export const createOrderSchema = z.object({
  order_id: z.string().trim().min(1).max(100),
  courier_partner: z.string().trim().toLowerCase().min(1).max(50),
  shipment: z.object({
    pickup: addressSchema,
    delivery: addressSchema,
    package: z.object({
      weight_kg: z.number().positive().max(500),
      length_cm: z.number().positive().max(500),
      width_cm: z.number().positive().max(500),
      height_cm: z.number().positive().max(500),
      declared_value: z.number().nonnegative(),
    }),
    payment_mode: z.enum(['PREPAID', 'COD']),
    cod_amount: z.number().nonnegative().optional(),
    currency: z.string().length(3).default('INR'),
    items: z.array(z.object({
      name: z.string().trim().min(1).max(150),
      quantity: z.number().int().positive(),
      unit_price: z.number().nonnegative(),
      sku: z.string().max(100).optional(),
    })).min(1).max(100),
  }).superRefine((shipment, context) => {
    if (shipment.payment_mode === 'COD' && shipment.cod_amount === undefined) {
      context.addIssue({ code: 'custom', path: ['cod_amount'], message: 'cod_amount is required for COD shipments' });
    }
  }),
});

export const bulkCreateSchema = z.object({
  orders: z.array(createOrderSchema).min(1).max(100),
});

export const courierPartnerSchema = z.object({
  courier_partner: z.string().trim().toLowerCase().min(1).max(50),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type ShipmentStatus = 'QUEUED' | 'PROCESSING' | 'CREATED' | 'PICKED_UP' | 'IN_TRANSIT' | 'DELIVERED' | 'CANCELLED' | 'FAILED' | 'UNKNOWN';

export const shipmentStatuses = new Set<ShipmentStatus>([
  'QUEUED', 'PROCESSING', 'CREATED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED', 'FAILED', 'UNKNOWN',
]);

export function normalizeStatus(value: unknown): ShipmentStatus {
  const status = String(value ?? '').trim().toUpperCase().replace(/[ -]+/g, '_');
  const aliases: Record<string, ShipmentStatus> = {
    BOOKED: 'CREATED',
    NEW: 'CREATED',
    PICKUP: 'PICKED_UP',
    PICKED: 'PICKED_UP',
    SHIPPED: 'IN_TRANSIT',
    OUT_FOR_DELIVERY: 'IN_TRANSIT',
    RTO: 'FAILED',
    CANCELED: 'CANCELLED',
  };
  if (aliases[status]) return aliases[status];
  return shipmentStatuses.has(status as ShipmentStatus) ? status as ShipmentStatus : 'UNKNOWN';
}