"use client";

import { LoaderCircle, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client-api";
import { ConfirmationDialog } from "./confirmation-dialog";

export function ReservationForm({ poolId }: { poolId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  return (
    <form
      className="inline-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setLoading(true);
        setError("");
        const form = new FormData(event.currentTarget);
        try {
          await api(`/api/pools/${poolId}/reservations`, {
            method: "POST",
            body: JSON.stringify({ ipAddress: form.get("ipAddress"), comment: form.get("comment") }),
          });
          event.currentTarget.reset();
          router.refresh();
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : "Reservation failed");
        } finally {
          setLoading(false);
        }
      }}
    >
      <div className="form-group">
        <label className="label" htmlFor="reservation-ip">IPv4 address</label>
        <input id="reservation-ip" className="field mono" name="ipAddress" required placeholder="10.20.30.10" />
      </div>
      <div className="form-group">
        <label className="label" htmlFor="reservation-comment">Comment</label>
        <input id="reservation-comment" className="field" name="comment" required placeholder="Server VPN" />
      </div>
      <button className="button button-primary" disabled={loading}>
        {loading ? <LoaderCircle className="spin" /> : <Plus />}{loading ? "Reserving…" : "Reserve"}
      </button>
      {error && <div className="form-message form-message-error" role="alert">{error}</div>}
    </form>
  );
}

export function RemoveReservationButton({ poolId, ip }: { poolId: string; ip: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  return (
    <>
      <button className="button button-small icon-button" aria-label={`Remove reservation for ${ip}`} onClick={() => setOpen(true)}>
        <Trash2 />
      </button>
      {open && <ConfirmationDialog
        title="Remove reserved address?"
        description={`${ip} will immediately become eligible for automatic allocation. Existing peers are not changed.`}
        confirmLabel="Remove reservation"
        loading={loading}
        error={error}
        onCancel={() => { setOpen(false); setError(""); }}
        onConfirm={async () => {
          setLoading(true);
          setError("");
          try {
            await api(`/api/pools/${poolId}/reservations`, { method: "DELETE", body: JSON.stringify({ ipAddress: ip }) });
            setOpen(false);
            router.refresh();
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Reservation removal failed");
          } finally {
            setLoading(false);
          }
        }}
      />}
    </>
  );
}

export function DeletePoolButton({ poolId, name }: { poolId: string; name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  return (
    <>
      <button className="button button-danger" onClick={() => setOpen(true)}><Trash2 />Delete pool</button>
      {open && <ConfirmationDialog
        title={`Delete ${name}?`}
        description="This removes the pool and its IPAM settings. Pools with assigned peers or reservations are protected and cannot be deleted. MikroTik configuration is not changed."
        confirmLabel="Delete pool"
        loading={loading}
        error={error}
        onCancel={() => { setOpen(false); setError(""); }}
        onConfirm={async () => {
          setLoading(true);
          setError("");
          try {
            await api(`/api/pools/${poolId}`, { method: "DELETE" });
            router.push("/pools");
            router.refresh();
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Pool deletion failed");
          } finally {
            setLoading(false);
          }
        }}
      />}
    </>
  );
}
