// Synthetic clock aging only. Never use against a hosted database.
const {elapseHealthClock}=require('./worker-health-fixture.cjs');
async function elapseTransportClock(query,seconds){
 await elapseHealthClock(query,seconds);
 await query("update analysis_scheduler_transport_state set reset_at=reset_at-$1::interval,last_enqueue_at=last_enqueue_at-$1::interval,failed_at=failed_at-$1::interval",[`${seconds} seconds`]);
 await query("update analysis_scheduler_transport_attempts set enqueued_at=enqueued_at-$1::interval,expires_at=expires_at-$1::interval,response_deadline=response_deadline-$1::interval,completed_at=completed_at-$1::interval",[`${seconds} seconds`]);
 await query("update analysis_scheduler_dispatches set issued_at=issued_at-$1::interval,expires_at=expires_at-$1::interval,claimed_at=claimed_at-$1::interval",[`${seconds} seconds`]);
}
module.exports={elapseTransportClock};
