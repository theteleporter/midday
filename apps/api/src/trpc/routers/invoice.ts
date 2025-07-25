import { getCustomerById } from "@api/db/queries/customers";
import { getInvoiceTemplate } from "@api/db/queries/invoice-templates";
import {
  deleteInvoice,
  draftInvoice,
  duplicateInvoice,
  getInvoiceById,
  getInvoiceSummary,
  getInvoices,
  getNextInvoiceNumber,
  getPaymentStatus,
  searchInvoiceNumber,
  updateInvoice,
} from "@api/db/queries/invoices";
import { getTeamById } from "@api/db/queries/teams";
import { getTrackerRecordsByRange } from "@api/db/queries/tracker-entries";
import { getTrackerProjectById } from "@api/db/queries/tracker-projects";
import { getUserById } from "@api/db/queries/users";
import {
  createInvoiceSchema,
  deleteInvoiceSchema,
  draftInvoiceSchema,
  duplicateInvoiceSchema,
  getInvoiceByIdSchema,
  getInvoiceByTokenSchema,
  getInvoicesSchema,
  invoiceSummarySchema,
  remindInvoiceSchema,
  searchInvoiceNumberSchema,
  updateInvoiceSchema,
} from "@api/schemas/invoice";
import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "@api/trpc/init";
import { parseInputValue } from "@api/utils/parse";
import { UTCDate } from "@date-fns/utc";
import { verify } from "@midday/invoice/token";
import { transformCustomerToContent } from "@midday/invoice/utils";
import type {
  GenerateInvoicePayload,
  SendInvoiceReminderPayload,
} from "@midday/jobs/schema";
import { tasks } from "@trigger.dev/sdk/v3";
import { TRPCError } from "@trpc/server";
import { addMonths, format, parseISO } from "date-fns";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

const defaultTemplate = {
  title: "Invoice",
  customerLabel: "To",
  fromLabel: "From",
  invoiceNoLabel: "Invoice No",
  issueDateLabel: "Issue Date",
  dueDateLabel: "Due Date",
  descriptionLabel: "Description",
  priceLabel: "Price",
  quantityLabel: "Quantity",
  totalLabel: "Total",
  totalSummaryLabel: "Total",
  subtotalLabel: "Subtotal",
  vatLabel: "VAT",
  taxLabel: "Tax",
  paymentLabel: "Payment Details",
  paymentDetails: undefined,
  noteLabel: "Note",
  logoUrl: undefined,
  currency: "USD",
  fromDetails: undefined,
  size: "a4",
  includeVat: true,
  includeTax: true,
  discountLabel: "Discount",
  includeDiscount: false,
  includeUnits: false,
  includeDecimals: false,
  includePdf: false,
  sendCopy: false,
  includeQr: true,
  dateFormat: "dd/MM/yyyy",
  taxRate: 0,
  vatRate: 0,
  deliveryType: "create",
  timezone: undefined,
  locale: undefined,
};

export const invoiceRouter = createTRPCRouter({
  get: protectedProcedure
    .input(getInvoicesSchema.optional())
    .query(async ({ input, ctx: { db, teamId } }) => {
      return getInvoices(db, {
        teamId: teamId!,
        ...input,
      });
    }),

  getById: protectedProcedure
    .input(getInvoiceByIdSchema)
    .query(async ({ input, ctx: { db, teamId } }) => {
      return getInvoiceById(db, {
        id: input.id,
        teamId: teamId!,
      });
    }),

  getInvoiceByToken: publicProcedure
    .input(getInvoiceByTokenSchema)
    .query(async ({ input, ctx: { db } }) => {
      const { id } = (await verify(decodeURIComponent(input.token))) as {
        id: string;
      };

      if (!id) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      return getInvoiceById(db, {
        id,
      });
    }),

  paymentStatus: protectedProcedure.query(async ({ ctx: { db, teamId } }) => {
    return getPaymentStatus(db, teamId!);
  }),

  searchInvoiceNumber: protectedProcedure
    .input(searchInvoiceNumberSchema)
    .query(async ({ input, ctx: { db, teamId } }) => {
      return searchInvoiceNumber(db, {
        teamId: teamId!,
        query: input.query,
      });
    }),

  invoiceSummary: protectedProcedure
    .input(invoiceSummarySchema.optional())
    .query(async ({ ctx: { db, teamId }, input }) => {
      return getInvoiceSummary(db, {
        teamId: teamId!,
        status: input?.status,
      });
    }),

  createFromTracker: protectedProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        dateFrom: z.string(),
        dateTo: z.string(),
      }),
    )
    .mutation(async ({ ctx: { db, teamId, session }, input }) => {
      const { projectId, dateFrom, dateTo } = input;

      // Get project data and tracker entries
      const [projectData, trackerData] = await Promise.all([
        getTrackerProjectById(db, { id: projectId, teamId: teamId! }),
        getTrackerRecordsByRange(db, {
          teamId: teamId!,
          projectId,
          from: dateFrom,
          to: dateTo,
        }),
      ]);

      if (!projectData) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "PROJECT_NOT_FOUND",
        });
      }

      // Check if project is billable
      if (!projectData.billable) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "PROJECT_NOT_BILLABLE",
        });
      }

      // Check if project has a rate
      if (!projectData.rate || projectData.rate <= 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "PROJECT_NO_RATE",
        });
      }

      // Calculate total hours from tracker entries
      const allEntries = Object.values(trackerData.result || {}).flat();
      const totalDuration = allEntries.reduce(
        (sum, entry) => sum + (entry.duration || 0),
        0,
      );
      const totalHours = Math.round((totalDuration / 3600) * 100) / 100;

      if (totalHours === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "NO_TRACKED_HOURS",
        });
      }

      // Get default invoice settings and customer details
      const [nextInvoiceNumber, template, team, fullCustomer, user] =
        await Promise.all([
          getNextInvoiceNumber(db, teamId!),
          getInvoiceTemplate(db, teamId!),
          getTeamById(db, teamId!),
          projectData.customerId
            ? getCustomerById(db, {
                id: projectData.customerId,
                teamId: teamId!,
              })
            : null,
          getUserById(db, session?.user.id!),
        ]);

      const invoiceId = uuidv4();
      const currency = projectData.currency || team?.baseCurrency || "USD";
      const amount = totalHours * Number(projectData.rate);

      // Get user's preferred date format
      const userDateFormat =
        template?.dateFormat ?? user?.dateFormat ?? defaultTemplate.dateFormat;

      // Format the date range for the line item description
      // Use parseISO to avoid timezone shifts when parsing date strings
      const formattedDateFrom = format(parseISO(dateFrom), userDateFormat);
      const formattedDateTo = format(parseISO(dateTo), userDateFormat);
      const dateRangeDescription = `${projectData.name} (${formattedDateFrom} - ${formattedDateTo})`;

      // Create draft invoice with tracker data
      const templateData = {
        ...defaultTemplate,
        currency: currency.toUpperCase(),
        ...(template
          ? Object.fromEntries(
              Object.entries(template).map(([key, value]) => [
                key,
                value === null ? undefined : value,
              ]),
            )
          : {}),
        size: (template?.size === "a4" || template?.size === "letter"
          ? template.size
          : defaultTemplate.size) as "a4" | "letter",
        deliveryType: (template?.deliveryType === "create" ||
        template?.deliveryType === "create_and_send"
          ? template.deliveryType
          : defaultTemplate.deliveryType) as
          | "create"
          | "create_and_send"
          | undefined,
      };

      const invoiceData = {
        id: invoiceId,
        teamId: teamId!,
        userId: session?.user.id!,
        customerId: projectData.customerId,
        customerName: fullCustomer?.name,
        invoiceNumber: nextInvoiceNumber,
        currency: currency.toUpperCase(),
        amount,
        lineItems: [
          {
            name: dateRangeDescription,
            quantity: totalHours,
            price: Number(projectData.rate),
            vat: 0,
          },
        ],
        issueDate: new Date().toISOString(),
        dueDate: addMonths(new Date(), 1).toISOString(),
        template: templateData,
        fromDetails: (template?.fromDetails || null) as string | null,
        paymentDetails: (template?.paymentDetails || null) as string | null,
        customerDetails: fullCustomer
          ? JSON.stringify(transformCustomerToContent(fullCustomer))
          : null,
        noteDetails: null,
        topBlock: null,
        bottomBlock: null,
        vat: null,
        tax: null,
        discount: null,
        subtotal: null,
      };

      return draftInvoice(db, invoiceData);
    }),

  defaultSettings: protectedProcedure.query(
    async ({ ctx: { db, teamId, session, geo } }) => {
      // Fetch invoice number, template, and team details concurrently
      const [nextInvoiceNumber, template, team, user] = await Promise.all([
        getNextInvoiceNumber(db, teamId!),
        getInvoiceTemplate(db, teamId!),
        getTeamById(db, teamId!),
        getUserById(db, session?.user.id!),
      ]);

      const locale = user?.locale ?? geo?.locale ?? "en";
      const timezone = user?.timezone ?? geo?.timezone ?? "America/New_York";
      const currency =
        template?.currency ?? team?.baseCurrency ?? defaultTemplate.currency;
      const dateFormat =
        template?.dateFormat ?? user?.dateFormat ?? defaultTemplate.dateFormat;
      const logoUrl = template?.logoUrl ?? defaultTemplate.logoUrl;
      const countryCode = geo?.country ?? "US";

      // Default to letter size for US/CA, A4 for rest of world
      const size = ["US", "CA"].includes(countryCode) ? "letter" : "a4";

      // Default to include sales tax for countries where it's common
      const includeTax = ["US", "CA", "AU", "NZ", "SG", "MY", "IN"].includes(
        countryCode,
      );

      const savedTemplate = {
        title: template?.title ?? defaultTemplate.title,
        logoUrl,
        currency,
        size: template?.size ?? defaultTemplate.size,
        includeTax: template?.includeTax ?? includeTax,
        includeVat: template?.includeVat ?? !includeTax,
        includeDiscount:
          template?.includeDiscount ?? defaultTemplate.includeDiscount,
        includeDecimals:
          template?.includeDecimals ?? defaultTemplate.includeDecimals,
        includeUnits: template?.includeUnits ?? defaultTemplate.includeUnits,
        includeQr: template?.includeQr ?? defaultTemplate.includeQr,
        includePdf: template?.includePdf ?? defaultTemplate.includePdf,
        sendCopy: template?.sendCopy ?? defaultTemplate.sendCopy,
        customerLabel: template?.customerLabel ?? defaultTemplate.customerLabel,
        fromLabel: template?.fromLabel ?? defaultTemplate.fromLabel,
        invoiceNoLabel:
          template?.invoiceNoLabel ?? defaultTemplate.invoiceNoLabel,
        subtotalLabel: template?.subtotalLabel ?? defaultTemplate.subtotalLabel,
        issueDateLabel:
          template?.issueDateLabel ?? defaultTemplate.issueDateLabel,
        totalSummaryLabel:
          template?.totalSummaryLabel ?? defaultTemplate.totalSummaryLabel,
        dueDateLabel: template?.dueDateLabel ?? defaultTemplate.dueDateLabel,
        discountLabel: template?.discountLabel ?? defaultTemplate.discountLabel,
        descriptionLabel:
          template?.descriptionLabel ?? defaultTemplate.descriptionLabel,
        priceLabel: template?.priceLabel ?? defaultTemplate.priceLabel,
        quantityLabel: template?.quantityLabel ?? defaultTemplate.quantityLabel,
        totalLabel: template?.totalLabel ?? defaultTemplate.totalLabel,
        vatLabel: template?.vatLabel ?? defaultTemplate.vatLabel,
        taxLabel: template?.taxLabel ?? defaultTemplate.taxLabel,
        paymentLabel: template?.paymentLabel ?? defaultTemplate.paymentLabel,
        noteLabel: template?.noteLabel ?? defaultTemplate.noteLabel,
        dateFormat,
        deliveryType: template?.deliveryType ?? defaultTemplate.deliveryType,
        taxRate: template?.taxRate ?? defaultTemplate.taxRate,
        vatRate: template?.vatRate ?? defaultTemplate.vatRate,
        fromDetails: template?.fromDetails ?? defaultTemplate.fromDetails,
        paymentDetails:
          template?.paymentDetails ?? defaultTemplate.paymentDetails,
        timezone,
        locale,
      };

      return {
        // Default values first
        id: uuidv4(),
        currency,
        status: "draft",
        size,
        includeTax: savedTemplate?.includeTax ?? includeTax,
        includeVat: savedTemplate?.includeVat ?? !includeTax,
        includeDiscount: false,
        includeDecimals: false,
        includePdf: false,
        sendCopy: false,
        includeUnits: false,
        includeQr: true,
        invoiceNumber: nextInvoiceNumber,
        timezone,
        locale,
        fromDetails: savedTemplate.fromDetails,
        paymentDetails: savedTemplate.paymentDetails,
        customerDetails: undefined,
        noteDetails: undefined,
        customerId: undefined,
        issueDate: new UTCDate().toISOString(),
        dueDate: addMonths(new UTCDate(), 1).toISOString(),
        lineItems: [{ name: "", quantity: 0, price: 0, vat: 0 }],
        tax: undefined,
        token: undefined,
        discount: undefined,
        subtotal: undefined,
        topBlock: undefined,
        bottomBlock: undefined,
        amount: undefined,
        customerName: undefined,
        logoUrl: undefined,
        vat: undefined,
        template: savedTemplate,
      };
    },
  ),

  update: protectedProcedure
    .input(updateInvoiceSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return updateInvoice(db, {
        ...input,
        teamId: teamId!,
      });
    }),

  delete: protectedProcedure
    .input(deleteInvoiceSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return deleteInvoice(db, {
        id: input.id,
        teamId: teamId!,
      });
    }),

  draft: protectedProcedure
    .input(draftInvoiceSchema)
    .mutation(async ({ input, ctx: { db, teamId, session } }) => {
      return draftInvoice(db, {
        ...input,
        teamId: teamId!,
        userId: session?.user.id!,
        paymentDetails: parseInputValue(input.paymentDetails),
        fromDetails: parseInputValue(input.fromDetails),
        customerDetails: parseInputValue(input.customerDetails),
        noteDetails: parseInputValue(input.noteDetails),
      });
    }),

  create: protectedProcedure
    .input(createInvoiceSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      // Update the invoice status to unpaid
      const data = await updateInvoice(db, {
        id: input.id,
        status: "unpaid",
        teamId: teamId!,
      });

      if (!data) {
        throw new Error("Invoice not found");
      }

      await tasks.trigger("generate-invoice", {
        invoiceId: data.id,
        deliveryType: input.deliveryType,
      } satisfies GenerateInvoicePayload);

      return data;
    }),

  remind: protectedProcedure
    .input(remindInvoiceSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      await tasks.trigger("send-invoice-reminder", {
        invoiceId: input.id,
      } satisfies SendInvoiceReminderPayload);

      return updateInvoice(db, {
        id: input.id,
        teamId: teamId!,
        reminderSentAt: input.date,
      });
    }),

  duplicate: protectedProcedure
    .input(duplicateInvoiceSchema)
    .mutation(async ({ input, ctx: { db, session, teamId } }) => {
      const nextInvoiceNumber = await getNextInvoiceNumber(db, teamId!);

      return duplicateInvoice(db, {
        id: input.id,
        userId: session?.user.id!,
        invoiceNumber: nextInvoiceNumber!,
        teamId: teamId!,
      });
    }),
});
