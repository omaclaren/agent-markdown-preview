# Setup
import numpy as np
import matplotlib.pyplot as plt
from scipy.integrate import odeint

def lorenz(p, t):
    x, y, z = p
    return 10*(y-x), x*(28-z)-y, x*y-8*z/3

t = np.linspace(0, 30, 6000)

# Pi
a = odeint(lorenz, [1, 1, 1], t)
plt.figure()
plt.plot(a[:, 0], a[:, 2])
plt.xlabel('x')
plt.ylabel('z')
plt.savefig('butterfly.png')

# Demo operator
b = odeint(lorenz, [1.0001, 1, 1], t)

# Claude Code
plt.figure()
plt.semilogy(t, np.linalg.norm(a - b, axis=1))
plt.xlabel('Time')
plt.ylabel('Separation')
plt.savefig('separation.png')
