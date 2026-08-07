use entros_anchor::IdentityState;

#[test]
fn identity_state_is_available_to_external_clients() {
    assert!(core::mem::size_of::<IdentityState>() > 0);
}
