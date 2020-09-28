const signIn = async (message) => {
  // Event triggered on successful sign in
}

const signOut = async (message) => {
  // Event triggered on sign out
}

const createUser = async (message) => {
  // Event triggered on user creation
}

const updateUser = async (message) => {
  // Event triggered when a user object is updated
}

const linkAccount = async (message) => {
  // Event triggered when an account is linked to a user
}

const session = async (message) => {
  // Event triggered when a session is active
}

const error = async (message) => {
  // @TODO Event triggered when something goes wrong in an authentication flow
  // This event may be fired multiple times when an error occurs
}

export default {
  signIn,
  signOut,
  createUser,
  updateUser,
  linkAccount,
  session,
  error
}
